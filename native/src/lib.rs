//! goshi-escrow, native version (no framework): rooms in SOL, saboteurs gated by a token balance, the house fee,
//! pass seats and manual vault withdrawal. The same rules as the Anchor version in ../programs/goshi-escrow, written
//! against Pinocchio so the binary is a few tens of KB and its deposit (rent) is a fraction of a SOL.
//!
//! Accounts (all owned by this program, first byte is a type tag):
//!   Config  PDA ["config"]            tag 1, 140 bytes
//!   Room    PDA ["room", id u64 LE]   tag 2, 471 bytes
//!   Vault   PDA ["vault"]             tag 3, 18 bytes (holds the house shares in lamports above its rent)
//!
//! Instructions (first byte of the data):
//!   0 initialize(min_holder u64, required_saboteurs u8)
//!   1 set_min_holder(u64)            2 set_required_saboteurs(u8)
//!   3 create_room(room_id u64, entry_fee u64 [, seed_commit 32])
//!   4 join_room(room_id u64)         5 join_free(room_id u64)       6 join_with_pass(room_id u64)
//!   7 start_vs                       8 finalize_royale(podium 3 x 32 [, proof 128])
//!   9 finalize_vs(n u8, ranking n x 32 [, proof 128])   10 cancel_room   11 withdraw_vault(amount u64)
//!   12 start_duel (2 to 5 paid players, no free ones)
//!   13 finalize_duel(winner 32 [, proof 128])  the winner takes the pot minus a 3 percent house fee
//!   14 set_authority  (the current authority AND the new one both sign: a typo cannot lock the program)
//!   15 set_wallets(infra 32, liquidity 32)  (authority only)
//!   16 create_duel(room_id u64, entry_fee u64, seed_commit 32, n u8, guests n x 32)  the HOST signs and pays the first seat;
//!      only the listed guests can take the other seats, so a duel is private by contract, not by a link
//!
//! Proof logs (no state, no rent): `create_room` logs the seed commitment, and the finalize instructions log
//!   proof = seed_reveal 32 | blockhash 32 | price_snapshot_hash 32 | replay_root 32
//! as `Program data` (sol_log_data). Indexers read them from the transaction; nothing is stored on chain.
//!
//! Money safety: entries live in the room account until it is settled. Only `authority` can settle or cancel. Every
//! payout is computed with integer math from the stored entry fee, and the room is closed in the same instruction.

#![cfg_attr(not(test), no_std)]

use pinocchio::{
    account_info::AccountInfo,
    default_allocator, nostd_panic_handler, program_entrypoint,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{create_program_address, find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{CreateAccount, Transfer};

program_entrypoint!(process_instruction);
default_allocator!();
#[cfg(not(test))]
nostd_panic_handler!();

// ───────────── constants ─────────────
pub const MAX_PAID: usize = 10;
pub const MAX_FREE: usize = 3;
pub const MIN_VS: usize = 2;
pub const MAX_VS: usize = 9;
/// A duel is a private room of 2 to 5 players where the winner takes everything but a small house fee.
pub const MAX_DUEL: usize = 5;
pub const DUEL_RAKE_PCT: u64 = 3;

const TAG_CONFIG: u8 = 1;
const TAG_ROOM: u8 = 2;
const TAG_VAULT: u8 = 3;

const CONFIG_LEN: usize = 140;
const ROOM_LEN: usize = 471;
const VAULT_LEN: usize = 18;

/// The classic SPL token program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
pub const SPL_TOKEN_ID: Pubkey = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58,
    140, 245, 133, 126, 255, 0, 169,
];

// ───────────── errors ─────────────
#[repr(u32)]
#[derive(Clone, Copy)]
pub enum E {
    Unauthorized = 6000,
    InvalidEntryFee,
    RoomMismatch,
    RoomNotWaiting,
    RoomNotActive,
    RoomFull,
    AlreadyJoined,
    NotEnoughGoshi,
    BadPlayerCount,
    DuplicateWinners,
    WinnerNotInRoom,
    WrongAccount,
    BadAccounts,
    MathOverflow,
    NothingPending,
    BadAccountData,
    AlreadyInitialized,
    BadInstruction,
}
impl From<E> for ProgramError {
    fn from(e: E) -> Self {
        ProgramError::Custom(e as u32)
    }
}
type R<T = ()> = Result<T, ProgramError>;

// ───────────── layout helpers ─────────────
fn rd_u64(d: &[u8], o: usize) -> u64 {
    { let mut b = [0u8; 8]; b.copy_from_slice(&d[o..o + 8]); u64::from_le_bytes(b) }
}
fn wr_u64(d: &mut [u8], o: usize, v: u64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
fn rd_key(d: &[u8], o: usize) -> Pubkey {
    { let mut k = [0u8; 32]; k.copy_from_slice(&d[o..o + 32]); k }
}

// Config offsets
const C_AUTH: usize = 1;
const C_INFRA: usize = 33;
const C_LIQ: usize = 65;
const C_MINT: usize = 97;
const C_MIN_HOLD: usize = 129;
const C_REQ_SAB: usize = 137;
const C_BUMP: usize = 138;
const C_VAULT_BUMP: usize = 139;
// Room offsets
const R_ID: usize = 1;
const R_FEE: usize = 9;
const R_STATE: usize = 17; // 0 waiting, 1 active
const R_MODE: usize = 18; // 0 royale, 1 vs, 2 duel
const R_PAID_LEN: usize = 19;
const R_FREE_LEN: usize = 20;
const R_PASSES: usize = 21;
const R_BUMP: usize = 22;
const R_PASS_PLAYER: usize = 23;
const R_PAID: usize = 55;
const R_FREE: usize = 375;
// Vault offsets
const V_BURN: usize = 1;
const V_JACKPOT: usize = 9;
const V_BUMP: usize = 17;

fn config_pda(program: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[b"config"], program)
}
fn vault_pda(program: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[b"vault"], program)
}

fn check_owned(a: &AccountInfo, program: &Pubkey, tag: u8, len: usize) -> R {
    if !a.is_owned_by(program) || a.data_len() != len {
        return Err(E::BadAccountData.into());
    }
    let d = a.try_borrow_data()?;
    if d[0] != tag {
        return Err(E::BadAccountData.into());
    }
    Ok(())
}

/// Checks that `acc` is the PDA made from the seeds and the stored bump.
fn check_pda(acc: &AccountInfo, seeds_and_bump: &[&[u8]], program: &Pubkey) -> R {
    let k = create_program_address(seeds_and_bump, program).map_err(|_| ProgramError::from(E::WrongAccount))?;
    if k != *acc.key() {
        return Err(E::WrongAccount.into());
    }
    Ok(())
}

fn load_config<'a>(a: &'a AccountInfo, program: &Pubkey) -> R<(Pubkey, Pubkey, Pubkey, Pubkey, u64, u8)> {
    check_owned(a, program, TAG_CONFIG, CONFIG_LEN)?;
    let d = a.try_borrow_data()?;
    let bump = d[C_BUMP];
    check_pda(a, &[b"config", &[bump]], program)?;
    Ok((
        rd_key(&d, C_AUTH),
        rd_key(&d, C_INFRA),
        rd_key(&d, C_LIQ),
        rd_key(&d, C_MINT),
        rd_u64(&d, C_MIN_HOLD),
        d[C_REQ_SAB],
    ))
}

fn require_authority(auth: &AccountInfo, cfg_auth: &Pubkey) -> R {
    if !auth.is_signer() || auth.key() != cfg_auth {
        return Err(E::Unauthorized.into());
    }
    Ok(())
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> R {
    if amount == 0 {
        return Ok(());
    }
    {
        let mut f = from.try_borrow_mut_lamports()?;
        *f = f.checked_sub(amount).ok_or(ProgramError::from(E::MathOverflow))?;
    }
    let mut t = to.try_borrow_mut_lamports()?;
    *t = t.checked_add(amount).ok_or(ProgramError::from(E::MathOverflow))?;
    Ok(())
}

/// Sends everything a room holds back to `to` and closes it.
fn close_room(room: &AccountInfo, to: &AccountInfo) -> R {
    let left = room.lamports();
    move_lamports(room, to, left)?;
    {
        let mut d = room.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
    }
    room.close()
}

fn room_id_of(room: &AccountInfo) -> R<u64> {
    Ok(rd_u64(&room.try_borrow_data()?, R_ID))
}

/// Loads the room, checks its owner, tag and PDA.
fn check_room(room: &AccountInfo, program: &Pubkey) -> R {
    check_owned(room, program, TAG_ROOM, ROOM_LEN)?;
    let (id, bump) = {
        let d = room.try_borrow_data()?;
        (rd_u64(&d, R_ID), d[R_BUMP])
    };
    check_pda(room, &[b"room", &id.to_le_bytes(), &[bump]], program)
}

fn paid_list(d: &[u8]) -> ([Pubkey; MAX_PAID], usize) {
    let n = d[R_PAID_LEN] as usize;
    let mut out = [[0u8; 32]; MAX_PAID];
    for i in 0..n.min(MAX_PAID) {
        out[i] = rd_key(d, R_PAID + 32 * i);
    }
    (out, n)
}
fn free_list(d: &[u8]) -> ([Pubkey; MAX_FREE], usize) {
    let n = d[R_FREE_LEN] as usize;
    let mut out = [[0u8; 32]; MAX_FREE];
    for i in 0..n.min(MAX_FREE) {
        out[i] = rd_key(d, R_FREE + 32 * i);
    }
    (out, n)
}
fn contains(list: &[Pubkey], n: usize, k: &Pubkey) -> bool {
    list[..n].iter().any(|x| x == k)
}

/// The invited wallets of a duel: three in the free-seat area (unused in a duel) and one in the pass-player slot.
fn is_guest(d: &[u8], k: &Pubkey) -> bool {
    if *k == [0u8; 32] {
        return false;
    }
    (0..3).any(|i| rd_key(d, R_FREE + 32 * i) == *k) || rd_key(d, R_PASS_PLAYER) == *k
}

fn maybe_activate(d: &mut [u8], required_saboteurs: u8) {
    if d[R_PAID_LEN] as usize == MAX_PAID && d[R_FREE_LEN] >= required_saboteurs {
        d[R_STATE] = 1;
    }
}

// ───────────── settlement math (mirrors the Anchor program and server/src/game/settlement.ts) ─────────────
/// a * p / 100 in u64: `create_room` caps the entry fee so that a pot times 100 always fits.
fn pct(a: u64, p: u64) -> Option<u64> {
    Some(a.checked_mul(p)? / 100)
}

pub struct Royale {
    pub rake: u64,
    pub buyback_burn: u64,
    pub infra: u64,
    pub liquidity: u64,
    pub rake_jackpot: u64,
    pub prizes: [u64; 3],
    pub saboteur_each: u64,
    pub saboteur_total: u64,
}

pub fn settle_royale(nominal: u64, cash: u64, saboteurs: u64) -> Option<Royale> {
    let prize_pool = pct(nominal, 88)?;
    let first = pct(prize_pool, 60)?;
    let second = pct(prize_pool, 25)?;
    let third = prize_pool.checked_sub(first)?.checked_sub(second)?;
    let sab_pool = pct(nominal, 2)?;
    let (each, total) = if saboteurs == 0 {
        (0, 0)
    } else {
        let e = sab_pool / saboteurs;
        (e, e.checked_mul(saboteurs)?)
    };
    let rake = cash.checked_sub(prize_pool)?.checked_sub(total)?;
    let burn = pct(rake, 10)?;
    let infra = pct(rake, 15)?;
    let liq = pct(rake, 25)?;
    let jackpot = rake.checked_sub(burn)?.checked_sub(infra)?.checked_sub(liq)?;
    Some(Royale {
        rake, buyback_burn: burn, infra, liquidity: liq, rake_jackpot: jackpot,
        prizes: [first, second, third], saboteur_each: each, saboteur_total: total,
    })
}

pub struct Vs {
    pub rake: u64,
    pub burn: u64,
    pub infra: u64,
    pub liquidity: u64,
    pub jackpot: u64,
    pub winner: u64,
    pub loser: u64,
}

pub fn settle_vs(entry: u64, players: u64) -> Option<Vs> {
    if players < MIN_VS as u64 || players > MAX_VS as u64 {
        return None;
    }
    let pot = entry.checked_mul(players)?;
    let rake = pct(pot, 10)?;
    let net = entry.checked_sub(pct(entry, 10)?)?;
    let loser = pct(net, 80)?;
    let winner = pot.checked_sub(rake)?.checked_sub(loser.checked_mul(players - 1)?)?;
    let burn = pct(rake, 10)?;
    let infra = pct(rake, 15)?;
    let liq = pct(rake, 25)?;
    let jackpot = rake.checked_sub(burn)?.checked_sub(infra)?.checked_sub(liq)?;
    Some(Vs { rake, burn, infra, liquidity: liq, jackpot, winner, loser })
}

pub struct Duel {
    pub rake: u64,
    pub burn: u64,
    pub infra: u64,
    pub liquidity: u64,
    pub jackpot: u64,
    pub winner: u64,
}

/// Winner takes all: the pot minus a 3 percent house fee, split like every other house share.
pub fn settle_duel(entry: u64, players: u64) -> Option<Duel> {
    if players < MIN_VS as u64 || players > MAX_DUEL as u64 {
        return None;
    }
    let pot = entry.checked_mul(players)?;
    let rake = pct(pot, DUEL_RAKE_PCT)?;
    let winner = pot.checked_sub(rake)?;
    let burn = pct(rake, 10)?;
    let infra = pct(rake, 15)?;
    let liq = pct(rake, 25)?;
    let jackpot = rake.checked_sub(burn)?.checked_sub(infra)?.checked_sub(liq)?;
    Some(Duel { rake, burn, infra, liquidity: liq, jackpot, winner })
}

// ───────────── entry point ─────────────
fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(ProgramError::from(E::BadInstruction))?;
    match tag {
        0 => initialize(program, accounts, rest),
        1 => set_u64(program, accounts, rest, C_MIN_HOLD),
        2 => set_required(program, accounts, rest),
        3 => create_room(program, accounts, rest),
        4 => join_room(program, accounts, rest),
        5 => join_free(program, accounts, rest),
        6 => join_with_pass(program, accounts, rest),
        7 => start_vs(program, accounts),
        8 => finalize_royale(program, accounts, rest),
        9 => finalize_vs(program, accounts, rest),
        10 => cancel_room(program, accounts),
        11 => withdraw_vault(program, accounts, rest),
        12 => start_duel(program, accounts),
        13 => finalize_duel(program, accounts, rest),
        14 => set_authority(program, accounts),
        15 => set_wallets(program, accounts, rest),
        16 => create_duel(program, accounts, rest),
        _ => Err(E::BadInstruction.into()),
    }
}

/// Logs a proof record: nothing is written to any account, so it costs no rent.
fn emit(kind: &[u8], room_id: u64, parts: &[&[u8]]) {
    let id = room_id.to_le_bytes();
    let mut list: [&[u8]; 6] = [&[]; 6];
    list[0] = kind;
    list[1] = &id;
    let mut n = 2;
    for p in parts.iter().take(4) {
        list[n] = p;
        n += 1;
    }
    pinocchio::log::sol_log_data(&list[..n]);
}

fn u64_arg(rest: &[u8]) -> R<u64> {
    if rest.len() < 8 {
        return Err(E::BadInstruction.into());
    }
    Ok(rd_u64(rest, 0))
}

fn create_pda<'a>(
    payer: &AccountInfo,
    acc: &AccountInfo,
    program: &Pubkey,
    len: usize,
    seeds: &[Seed],
) -> R {
    let lamports = Rent::get()?.minimum_balance(len);
    CreateAccount { from: payer, to: acc, lamports, space: len as u64, owner: program }
        .invoke_signed(&[Signer::from(seeds)])
}

// accounts: authority(s,w), config(w), vault(w), infra, liquidity, mint, system_program
fn initialize(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, config, vault, infra, liquidity, mint, _system] = a else {
        return Err(E::BadAccounts.into());
    };
    if !authority.is_signer() || d.len() < 9 {
        return Err(E::Unauthorized.into());
    }
    let min_hold = rd_u64(d, 0);
    let required = d[8];
    if required as usize > MAX_FREE {
        return Err(E::BadPlayerCount.into());
    }
    if !mint.is_owned_by(&SPL_TOKEN_ID) {
        return Err(E::WrongAccount.into());
    }
    let (cfg_key, cfg_bump) = config_pda(program);
    let (vault_key, vault_bump) = vault_pda(program);
    if *config.key() != cfg_key || *vault.key() != vault_key {
        return Err(E::WrongAccount.into());
    }
    if config.data_len() != 0 || !config.is_owned_by(&[0u8; 32]) {
        return Err(E::AlreadyInitialized.into());
    }
    create_pda(authority, config, program, CONFIG_LEN, &[Seed::from(b"config"), Seed::from(&[cfg_bump])])?;
    create_pda(authority, vault, program, VAULT_LEN, &[Seed::from(b"vault"), Seed::from(&[vault_bump])])?;
    {
        let mut c = config.try_borrow_mut_data()?;
        c[0] = TAG_CONFIG;
        c[C_AUTH..C_AUTH + 32].copy_from_slice(authority.key());
        c[C_INFRA..C_INFRA + 32].copy_from_slice(infra.key());
        c[C_LIQ..C_LIQ + 32].copy_from_slice(liquidity.key());
        c[C_MINT..C_MINT + 32].copy_from_slice(mint.key());
        wr_u64(&mut c, C_MIN_HOLD, min_hold);
        c[C_REQ_SAB] = required;
        c[C_BUMP] = cfg_bump;
        c[C_VAULT_BUMP] = vault_bump;
    }
    let mut v = vault.try_borrow_mut_data()?;
    v[0] = TAG_VAULT;
    v[V_BUMP] = vault_bump;
    Ok(())
}

// accounts: authority(s), config(w)
fn set_u64(program: &Pubkey, a: &[AccountInfo], d: &[u8], off: usize) -> ProgramResult {
    let [authority, config] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    wr_u64(&mut config.try_borrow_mut_data()?, off, u64_arg(d)?);
    Ok(())
}

fn set_required(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, config] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    let v = *d.first().ok_or(ProgramError::from(E::BadInstruction))?;
    if v as usize > MAX_FREE {
        return Err(E::BadPlayerCount.into());
    }
    config.try_borrow_mut_data()?[C_REQ_SAB] = v;
    Ok(())
}

// accounts: authority(s,w), config, room(w), system
fn create_room(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, config, room, _system] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    if d.len() < 16 {
        return Err(E::BadInstruction.into());
    }
    let id = rd_u64(d, 0);
    let fee = rd_u64(d, 8);
    // Up to 1,000,000 SOL: keeps every pot times 100 inside u64.
    if fee == 0 || fee > 1_000_000_000_000_000 {
        return Err(E::InvalidEntryFee.into());
    }
    let id_bytes = id.to_le_bytes();
    let (key, bump) = find_program_address(&[b"room", &id_bytes], program);
    if key != *room.key() {
        return Err(E::WrongAccount.into());
    }
    create_pda(authority, room, program, ROOM_LEN, &[Seed::from(b"room"), Seed::from(&id_bytes), Seed::from(&[bump])])?;
    let mut r = room.try_borrow_mut_data()?;
    r[0] = TAG_ROOM;
    wr_u64(&mut r, R_ID, id);
    wr_u64(&mut r, R_FEE, fee);
    r[R_BUMP] = bump;
    if d.len() >= 48 {
        emit(b"goshi:commit", id, &[&d[16..48]]);
    }
    Ok(())
}

// accounts: player(s,w), config, room(w), system
fn join_room(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [player, config, room, _system] = a else { return Err(E::BadAccounts.into()) };
    if !player.is_signer() {
        return Err(E::Unauthorized.into());
    }
    let (_, _, _, _, _, required) = load_config(config, program)?;
    check_room(room, program)?;
    let id = u64_arg(d)?;
    let fee;
    {
        let r = room.try_borrow_data()?;
        if rd_u64(&r, R_ID) != id {
            return Err(E::RoomMismatch.into());
        }
        if r[R_STATE] != 0 {
            return Err(E::RoomNotWaiting.into());
        }
        // A duel is private by contract: only the host (already seated) and the invited wallets can take a seat.
        if r[R_MODE] == 2 && !is_guest(&r, player.key()) {
            return Err(E::Unauthorized.into());
        }
        let (paid, pn) = paid_list(&r);
        let (free, fnn) = free_list(&r);
        if pn >= MAX_PAID || (r[R_MODE] == 2 && pn >= MAX_DUEL) {
            return Err(E::RoomFull.into());
        }
        if contains(&paid, pn, player.key()) || contains(&free, fnn, player.key()) {
            return Err(E::AlreadyJoined.into());
        }
        fee = rd_u64(&r, R_FEE);
    }
    Transfer { from: player, to: room, lamports: fee }.invoke()?;
    let mut r = room.try_borrow_mut_data()?;
    let n = r[R_PAID_LEN] as usize;
    r[R_PAID + 32 * n..R_PAID + 32 * n + 32].copy_from_slice(player.key());
    r[R_PAID_LEN] = (n + 1) as u8;
    maybe_activate(&mut r, required);
    Ok(())
}

// accounts: player(s), config, room(w), player_token
fn join_free(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [player, config, room, token] = a else { return Err(E::BadAccounts.into()) };
    if !player.is_signer() {
        return Err(E::Unauthorized.into());
    }
    let (_, _, _, mint, min_hold, required) = load_config(config, program)?;
    check_room(room, program)?;
    // Saboteur seats exist only in royale rooms (a duel keeps its invited wallets where the saboteurs would be written).
    if room.try_borrow_data()?[R_MODE] != 0 {
        return Err(E::RoomNotWaiting.into());
    }
    // The token account must be a classic SPL token account of the mint, owned by the player, with enough balance.
    if !token.is_owned_by(&SPL_TOKEN_ID) || token.data_len() != 165 {
        return Err(E::NotEnoughGoshi.into());
    }
    {
        let t = token.try_borrow_data()?;
        if rd_key(&t, 0) != mint || rd_key(&t, 32) != *player.key() || rd_u64(&t, 64) < min_hold {
            return Err(E::NotEnoughGoshi.into());
        }
    }
    let id = u64_arg(d)?;
    let mut r = room.try_borrow_mut_data()?;
    if rd_u64(&r, R_ID) != id {
        return Err(E::RoomMismatch.into());
    }
    if r[R_STATE] != 0 || r[R_MODE] != 0 {
        return Err(E::RoomNotWaiting.into());
    }
    let (paid, pn) = paid_list(&r);
    let (free, fnn) = free_list(&r);
    if fnn >= MAX_FREE {
        return Err(E::RoomFull.into());
    }
    if contains(&paid, pn, player.key()) || contains(&free, fnn, player.key()) {
        return Err(E::AlreadyJoined.into());
    }
    r[R_FREE + 32 * fnn..R_FREE + 32 * fnn + 32].copy_from_slice(player.key());
    r[R_FREE_LEN] = (fnn + 1) as u8;
    maybe_activate(&mut r, required);
    Ok(())
}

// accounts: authority(s), player, config, room(w)
fn join_with_pass(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, player, config, room] = a else { return Err(E::BadAccounts.into()) };
    let (auth, _, _, _, _, required) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    let id = u64_arg(d)?;
    let mut r = room.try_borrow_mut_data()?;
    if rd_u64(&r, R_ID) != id {
        return Err(E::RoomMismatch.into());
    }
    if r[R_STATE] != 0 || r[R_MODE] != 0 {
        return Err(E::RoomNotWaiting.into());
    }
    let (paid, pn) = paid_list(&r);
    let (free, fnn) = free_list(&r);
    if pn != MAX_PAID - 1 {
        return Err(E::BadPlayerCount.into());
    }
    if r[R_PASSES] != 0 {
        return Err(E::RoomFull.into());
    }
    if contains(&paid, pn, player.key()) || contains(&free, fnn, player.key()) {
        return Err(E::AlreadyJoined.into());
    }
    r[R_PAID + 32 * pn..R_PAID + 32 * pn + 32].copy_from_slice(player.key());
    r[R_PAID_LEN] = (pn + 1) as u8;
    r[R_PASSES] = 1;
    r[R_PASS_PLAYER..R_PASS_PLAYER + 32].copy_from_slice(player.key());
    maybe_activate(&mut r, required);
    Ok(())
}

// accounts: authority(s), config, room(w)
fn start_vs(program: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [authority, config, room] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    let mut r = room.try_borrow_mut_data()?;
    let n = r[R_PAID_LEN] as usize;
    if r[R_STATE] != 0 {
        return Err(E::RoomNotWaiting.into());
    }
    if n < MIN_VS || n > MAX_VS || r[R_PASSES] != 0 {
        return Err(E::BadPlayerCount.into());
    }
    r[R_FREE_LEN] = 0;
    r[R_MODE] = 1;
    r[R_STATE] = 1;
    Ok(())
}

// accounts: authority(s,w), host(s,w), config, room(w), system
fn create_duel(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, host, config, room, _system] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    if !host.is_signer() {
        return Err(E::Unauthorized.into());
    }
    if d.len() < 49 {
        return Err(E::BadInstruction.into());
    }
    let id = rd_u64(d, 0);
    let fee = rd_u64(d, 8);
    let n = d[48] as usize;
    if n < 1 || n > MAX_DUEL - 1 || d.len() != 49 + 32 * n {
        return Err(E::BadPlayerCount.into());
    }
    if fee == 0 || fee > 1_000_000_000_000_000 {
        return Err(E::InvalidEntryFee.into());
    }
    // The guests: distinct, never the host, never the zero key.
    for i in 0..n {
        let g = rd_key(d, 49 + 32 * i);
        if g == [0u8; 32] || g == *host.key() {
            return Err(E::BadInstruction.into());
        }
        for j in 0..i {
            if rd_key(d, 49 + 32 * j) == g {
                return Err(E::DuplicateWinners.into());
            }
        }
    }
    let id_bytes = id.to_le_bytes();
    let (key, bump) = find_program_address(&[b"room", &id_bytes], program);
    if key != *room.key() {
        return Err(E::WrongAccount.into());
    }
    create_pda(authority, room, program, ROOM_LEN, &[Seed::from(b"room"), Seed::from(&id_bytes), Seed::from(&[bump])])?;
    // The host pays the first seat in the same transaction: signing it is accepting the duel as its host.
    Transfer { from: host, to: room, lamports: fee }.invoke()?;
    {
        let mut r = room.try_borrow_mut_data()?;
        r[0] = TAG_ROOM;
        wr_u64(&mut r, R_ID, id);
        wr_u64(&mut r, R_FEE, fee);
        r[R_BUMP] = bump;
        r[R_MODE] = 2;
        r[R_PAID..R_PAID + 32].copy_from_slice(host.key());
        r[R_PAID_LEN] = 1;
        for i in 0..n {
            let g = &d[49 + 32 * i..49 + 32 * i + 32];
            if i < 3 {
                r[R_FREE + 32 * i..R_FREE + 32 * i + 32].copy_from_slice(g);
            } else {
                r[R_PASS_PLAYER..R_PASS_PLAYER + 32].copy_from_slice(g);
            }
        }
    }
    emit(b"goshi:commit", id, &[&d[16..48]]);
    Ok(())
}

// accounts: authority(s), new_authority(s), config(w)
fn set_authority(program: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [authority, new_authority, config] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    // The new key must sign too, so the authority can only ever be handed to a key somebody holds.
    if !new_authority.is_signer() || *new_authority.key() == [0u8; 32] {
        return Err(E::Unauthorized.into());
    }
    config.try_borrow_mut_data()?[C_AUTH..C_AUTH + 32].copy_from_slice(new_authority.key());
    Ok(())
}

// accounts: authority(s), config(w)
fn set_wallets(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, config] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    if d.len() < 64 || rd_key(d, 0) == [0u8; 32] || rd_key(d, 32) == [0u8; 32] {
        return Err(E::BadInstruction.into());
    }
    let mut c = config.try_borrow_mut_data()?;
    c[C_INFRA..C_INFRA + 32].copy_from_slice(&d[0..32]);
    c[C_LIQ..C_LIQ + 32].copy_from_slice(&d[32..64]);
    Ok(())
}

// accounts: authority(s), config, room(w)
fn start_duel(program: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [authority, config, room] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    let mut r = room.try_borrow_mut_data()?;
    let n = r[R_PAID_LEN] as usize;
    if r[R_STATE] != 0 {
        return Err(E::RoomNotWaiting.into());
    }
    if n < MIN_VS || n > MAX_DUEL || r[R_PASSES] != 0 {
        return Err(E::BadPlayerCount.into());
    }
    r[R_FREE_LEN] = 0;
    r[R_MODE] = 2;
    r[R_STATE] = 1;
    Ok(())
}

fn pay_house(
    room: &AccountInfo, vault: &AccountInfo, infra: &AccountInfo, liquidity: &AccountInfo,
    infra_amt: u64, liq_amt: u64, burn: u64, jackpot: u64,
) -> R {
    move_lamports(room, infra, infra_amt)?;
    move_lamports(room, liquidity, liq_amt)?;
    let to_vault = burn.checked_add(jackpot).ok_or(ProgramError::from(E::MathOverflow))?;
    move_lamports(room, vault, to_vault)?;
    let mut v = vault.try_borrow_mut_data()?;
    let b = rd_u64(&v, V_BURN).checked_add(burn).ok_or(ProgramError::from(E::MathOverflow))?;
    let j = rd_u64(&v, V_JACKPOT).checked_add(jackpot).ok_or(ProgramError::from(E::MathOverflow))?;
    wr_u64(&mut v, V_BURN, b);
    wr_u64(&mut v, V_JACKPOT, j);
    Ok(())
}

fn check_vault(vault: &AccountInfo, program: &Pubkey) -> R {
    check_owned(vault, program, TAG_VAULT, VAULT_LEN)?;
    let bump = vault.try_borrow_data()?[V_BUMP];
    check_pda(vault, &[b"vault", &[bump]], program)
}

// accounts: authority(s,w), config, room(w), vault(w), infra(w), liquidity(w), then 3 podium wallets + the saboteurs
fn finalize_royale(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    if a.len() < 9 {
        return Err(E::BadAccounts.into());
    }
    let (authority, config, room, vault, infra, liquidity) = (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5]);
    let remaining = &a[6..];
    let (auth, cfg_infra, cfg_liq, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    check_vault(vault, program)?;
    if *infra.key() != cfg_infra || *liquidity.key() != cfg_liq {
        return Err(E::WrongAccount.into());
    }
    if d.len() < 96 {
        return Err(E::BadInstruction.into());
    }
    let podium = [rd_key(d, 0), rd_key(d, 32), rd_key(d, 64)];
    if podium[0] == podium[1] || podium[0] == podium[2] || podium[1] == podium[2] {
        return Err(E::DuplicateWinners.into());
    }
    let (fee, paid_n, passes, free, free_n) = {
        let r = room.try_borrow_data()?;
        if r[R_STATE] != 1 || r[R_MODE] != 0 {
            return Err(E::RoomNotActive.into());
        }
        let (paid, pn) = paid_list(&r);
        for w in podium.iter() {
            if !contains(&paid, pn, w) {
                return Err(E::WinnerNotInRoom.into());
            }
        }
        let (free, fnn) = free_list(&r);
        (rd_u64(&r, R_FEE), pn as u64, r[R_PASSES] as u64, free, fnn)
    };
    if remaining.len() != 3 + free_n {
        return Err(E::BadAccounts.into());
    }
    let nominal = fee.checked_mul(paid_n).ok_or(ProgramError::from(E::MathOverflow))?;
    let cash = fee.checked_mul(paid_n - passes).ok_or(ProgramError::from(E::MathOverflow))?;
    let s = settle_royale(nominal, cash, free_n as u64).ok_or(ProgramError::from(E::MathOverflow))?;
    for i in 0..3 {
        let acc = &remaining[i];
        if *acc.key() != podium[i] || !acc.is_writable() {
            return Err(E::WrongAccount.into());
        }
        move_lamports(room, acc, s.prizes[i])?;
    }
    for i in 0..free_n {
        let acc = &remaining[3 + i];
        if *acc.key() != free[i] || !acc.is_writable() {
            return Err(E::WrongAccount.into());
        }
        move_lamports(room, acc, s.saboteur_each)?;
    }
    pay_house(room, vault, infra, liquidity, s.infra, s.liquidity, s.buyback_burn, s.rake_jackpot)?;
    if d.len() >= 96 + 128 {
        emit(b"goshi:proof", room_id_of(room)?, &[&d[96..128], &d[128..160], &d[160..192], &d[192..224]]);
    }
    close_room(room, authority)
}

// accounts: authority(s,w), config, room(w), vault(w), infra(w), liquidity(w), then every paid wallet in ranking order
fn finalize_vs(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    if a.len() < 6 {
        return Err(E::BadAccounts.into());
    }
    let (authority, config, room, vault, infra, liquidity) = (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5]);
    let remaining = &a[6..];
    let (auth, cfg_infra, cfg_liq, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    check_vault(vault, program)?;
    if *infra.key() != cfg_infra || *liquidity.key() != cfg_liq {
        return Err(E::WrongAccount.into());
    }
    let n = *d.first().ok_or(ProgramError::from(E::BadInstruction))? as usize;
    if n < MIN_VS || n > MAX_VS || d.len() < 1 + 32 * n || remaining.len() != n {
        return Err(E::BadPlayerCount.into());
    }
    let (fee, paid, paid_n) = {
        let r = room.try_borrow_data()?;
        if r[R_STATE] != 1 || r[R_MODE] != 1 {
            return Err(E::RoomNotActive.into());
        }
        let (paid, pn) = paid_list(&r);
        (rd_u64(&r, R_FEE), paid, pn)
    };
    if n != paid_n {
        return Err(E::BadPlayerCount.into());
    }
    let s = settle_vs(fee, n as u64).ok_or(ProgramError::from(E::MathOverflow))?;
    for i in 0..n {
        let w = rd_key(d, 1 + 32 * i);
        if !contains(&paid, paid_n, &w) {
            return Err(E::WinnerNotInRoom.into());
        }
        for j in 0..i {
            if rd_key(d, 1 + 32 * j) == w {
                return Err(E::DuplicateWinners.into());
            }
        }
        let acc = &remaining[i];
        if *acc.key() != w || !acc.is_writable() {
            return Err(E::WrongAccount.into());
        }
        move_lamports(room, acc, if i == 0 { s.winner } else { s.loser })?;
    }
    pay_house(room, vault, infra, liquidity, s.infra, s.liquidity, s.burn, s.jackpot)?;
    let po = 1 + 32 * n;
    if d.len() >= po + 128 {
        emit(b"goshi:proof", room_id_of(room)?, &[&d[po..po + 32], &d[po + 32..po + 64], &d[po + 64..po + 96], &d[po + 96..po + 128]]);
    }
    close_room(room, authority)
}

// accounts: authority(s,w), config, room(w), vault(w), infra(w), liquidity(w), winner(w)
fn finalize_duel(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    if a.len() != 7 {
        return Err(E::BadAccounts.into());
    }
    let (authority, config, room, vault, infra, liquidity, winner_acc) = (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6]);
    let (auth, cfg_infra, cfg_liq, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    check_vault(vault, program)?;
    if *infra.key() != cfg_infra || *liquidity.key() != cfg_liq {
        return Err(E::WrongAccount.into());
    }
    if d.len() < 32 {
        return Err(E::BadInstruction.into());
    }
    let winner = rd_key(d, 0);
    let (fee, n) = {
        let r = room.try_borrow_data()?;
        if r[R_STATE] != 1 || r[R_MODE] != 2 {
            return Err(E::RoomNotActive.into());
        }
        let (paid, pn) = paid_list(&r);
        if !contains(&paid, pn, &winner) {
            return Err(E::WinnerNotInRoom.into());
        }
        (rd_u64(&r, R_FEE), pn as u64)
    };
    if *winner_acc.key() != winner || !winner_acc.is_writable() {
        return Err(E::WrongAccount.into());
    }
    let s = settle_duel(fee, n).ok_or(ProgramError::from(E::MathOverflow))?;
    move_lamports(room, winner_acc, s.winner)?;
    pay_house(room, vault, infra, liquidity, s.infra, s.liquidity, s.burn, s.jackpot)?;
    if d.len() >= 32 + 128 {
        emit(b"goshi:proof", room_id_of(room)?, &[&d[32..64], &d[64..96], &d[96..128], &d[128..160]]);
    }
    close_room(room, authority)
}

// accounts: authority(s,w), config, room(w), then the refunded wallets (every paid player except a pass holder)
fn cancel_room(program: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    if a.len() < 3 {
        return Err(E::BadAccounts.into());
    }
    let (authority, config, room) = (&a[0], &a[1], &a[2]);
    let remaining = &a[3..];
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_room(room, program)?;
    let (fee, paid, pn, pass_player, passes) = {
        let r = room.try_borrow_data()?;
        let (paid, pn) = paid_list(&r);
        (rd_u64(&r, R_FEE), paid, pn, rd_key(&r, R_PASS_PLAYER), r[R_PASSES])
    };
    let mut k = 0usize;
    for i in 0..pn {
        if passes > 0 && paid[i] == pass_player {
            continue;
        }
        let acc = remaining.get(k).ok_or(ProgramError::from(E::BadAccounts))?;
        if *acc.key() != paid[i] || !acc.is_writable() {
            return Err(E::WrongAccount.into());
        }
        move_lamports(room, acc, fee)?;
        k += 1;
    }
    if k != remaining.len() {
        return Err(E::BadAccounts.into());
    }
    close_room(room, authority)
}

// accounts: authority(s), config, vault(w), destination(w)
fn withdraw_vault(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [authority, config, vault, dest] = a else { return Err(E::BadAccounts.into()) };
    let (auth, ..) = load_config(config, program)?;
    require_authority(authority, &auth)?;
    check_vault(vault, program)?;
    let amount = u64_arg(d)?;
    {
        let mut v = vault.try_borrow_mut_data()?;
        let burn = rd_u64(&v, V_BURN);
        let jack = rd_u64(&v, V_JACKPOT);
        if amount == 0 || amount > burn.checked_add(jack).ok_or(ProgramError::from(E::MathOverflow))? {
            return Err(E::NothingPending.into());
        }
        let from_burn = amount.min(burn);
        wr_u64(&mut v, V_BURN, burn - from_burn);
        wr_u64(&mut v, V_JACKPOT, jack - (amount - from_burn));
    }
    move_lamports(vault, dest, amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SOL: u64 = 1_000_000_000;

    #[test]
    fn royale_standard_room() {
        let s = settle_royale(10 * SOL, 10 * SOL, 3).unwrap();
        assert_eq!(s.prizes, [5_280_000_000, 2_200_000_000, 1_320_000_000]);
        assert_eq!(s.saboteur_each, 66_666_666);
        assert_eq!(s.prizes.iter().sum::<u64>() + s.saboteur_total + s.rake, 10 * SOL);
        assert_eq!(s.buyback_burn + s.infra + s.liquidity + s.rake_jackpot, s.rake);
    }

    #[test]
    fn pass_seat_is_solvent_and_two_are_refused() {
        let fee = 7_500_000_000u64;
        let s = settle_royale(fee * 10, fee * 9, 3).unwrap();
        assert!(s.rake <= 3);
        assert!(settle_royale(fee * 10, fee * 8, 3).is_none());
    }

    #[test]
    fn vs_conserves() {
        for n in 2..=9u64 {
            let s = settle_vs(123_456_789, n).unwrap();
            assert_eq!(s.winner + s.loser * (n - 1) + s.rake, 123_456_789 * n);
        }
        let s = settle_vs(SOL, 2).unwrap();
        assert_eq!((s.loser, s.winner), (720_000_000, 1_080_000_000));
    }

    #[test]
    fn duel_conserves_and_pays_the_winner_everything_but_the_fee() {
        for n in 2..=5u64 {
            let s = settle_duel(123_456_789, n).unwrap();
            assert_eq!(s.winner + s.rake, 123_456_789 * n);
            assert_eq!(s.burn + s.infra + s.liquidity + s.jackpot, s.rake);
        }
        let s = settle_duel(SOL, 2).unwrap();
        assert_eq!((s.winner, s.rake), (1_940_000_000, 60_000_000));
        assert!(settle_duel(SOL, 1).is_none());
        assert!(settle_duel(SOL, 6).is_none());
    }

    #[test]
    fn spl_token_id_bytes_are_right() {
        // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, base58 decoded.
        let expected: [u8; 32] = [
            6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55,
            145, 58, 140, 245, 133, 126, 255, 0, 169,
        ];
        assert_eq!(SPL_TOKEN_ID, expected);
    }
}
