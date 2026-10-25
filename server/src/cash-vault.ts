// The cash arena on the test network, with real devnet SOL and everything on chain. Entries are paid by the players' own
// wallets straight to the arena vault (a devnet wallet of the server) and checked on chain before a place is given; a cash out
// is paid from the vault to the player's wallet. While people play, the arena bots enter and cash out the same way from their own
// devnet wallets, so the money that falls on the map always comes from real transfers. Every transfer is logged to the ledger.
// Devnet only: on mainnet this module does nothing and the cash arena is not offered.
import crypto from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config, log } from "./config.js";
// The chain module reads the server key when it loads: it is only loaded when a function here really needs it (never in tests).
let chainP: Promise<typeof import("./chain.js")> | null = null;
const chain = () => (chainP ??= import("./chain.js"));
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

const devnet = config.cluster === "devnet";
/** The vault of the cash arena: derived from the server key, so every instance and every restart has the same one. */
let vaultKp: Keypair | null = null;
/** Its address, known once initVault ran (empty before). */
export let vaultAddress = "";
export async function initVault(): Promise<Keypair> {
  if (vaultKp) return vaultKp;
  const { authority } = await chain();
  vaultKp = Keypair.fromSeed(Uint8Array.from(crypto.createHash("sha256").update("goshi-cash-vault-v1").update(authority.secretKey).digest()));
  vaultAddress = vaultKp.publicKey.toBase58();
  return vaultKp;
}

async function send(from: Keypair, to: PublicKey, lamports: number, payer: Keypair = from): Promise<string> {
  const { connection } = await chain();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...(payer === from ? [from] : [payer, from]));
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** One line of the ledger: every entry and every payout, with its signature on chain. */
export async function ledger(kind: "entry" | "payout" | "bot_entry" | "bot_payout", wallet: string, lamports: number, sig: string): Promise<void> {
  log("cash_ledger", { kind, wallet, lamports, sig });
  if (!firestoreReady()) return;
  try {
    await fetch(`${firestoreBase()}/cashledger/${encodeURIComponent(sig)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { kind: { stringValue: kind }, wallet: { stringValue: wallet }, lamports: { integerValue: String(lamports) }, sig: { stringValue: sig }, at: { integerValue: String(Date.now()) }, cluster: { stringValue: config.cluster } } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* the log line above is kept anyway */ }
}

/**
 * Tickets. Every transfer a wallet made to the vault is a ticket for one place in the cash arena, and it stays valid until it is
 * used: the chain is the record of what was paid, and the ledger line written when the place is taken (cashledger/<signature>)
 * is the record of its use. So a payment can never be lost: if the place could not be given, the same payment enters next time.
 */
const TICKET_TTL_S = 48 * 3600;
const usedSigs = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when this signature already bought a place (its ledger line exists). */
async function ticketUsed(sig: string): Promise<boolean> {
  if (usedSigs.has(sig)) return true;
  if (!firestoreReady()) return false;
  try {
    const r = await fetch(`${firestoreBase()}/cashledger/${encodeURIComponent(sig)}`, { headers: { authorization: `Bearer ${await firestoreToken()}` }, signal: AbortSignal.timeout(8000) });
    if (r.status === 200) { usedSigs.set(sig, Date.now()); return true; }
  } catch { /* unknown: treated as unused, the in-memory set still stops a second use here */ }
  return false;
}

type Paid = { payer: string; got: number; at: number } | null;
const paidCache = new Map<string, Paid>();
/** What a transaction paid into the vault, and who paid it (read once from the chain, retried while the RPC refuses). */
async function paidOf(sig: string, tries = 10): Promise<Paid | undefined> {
  const { connection } = await chain();
  await initVault();
  if (paidCache.has(sig)) return paidCache.get(sig)!;
  for (let t = 0; t < tries; t++) {
    try {
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) {
        let v: Paid = null;
        if (tx.meta && !tx.meta.err && tx.blockTime) {
          const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
          const i = keys.indexOf(vaultAddress);
          v = { payer: keys[0], got: i < 0 ? 0 : tx.meta.postBalances[i] - tx.meta.preBalances[i], at: tx.blockTime };
        }
        paidCache.set(sig, v);
        return v;
      }
    } catch { /* 429 or a network error: wait and retry */ }
    await sleep(1000 * Math.min(8, 2 ** t));
  }
  return undefined;
}

/**
 * Checks a ticket: the transaction succeeded, is under 48 h old, was never used, its fee payer is the wallet that signed in, and
 * it moved at least `min` lamports into the vault. Returns what really reached the vault. It does not use the ticket: call
 * useTicket once the place is really given.
 */
export async function checkEntry(sig: string, wallet: string, min: number): Promise<{ ok: true; lamports: number } | { ok: false; why: string }> {
  if (!devnet) return { ok: false, why: "devnet_only" };
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return { ok: false, why: "bad" };
  if (await ticketUsed(sig)) return { ok: false, why: "used" };
  const p = await paidOf(sig);
  if (p === undefined) return { ok: false, why: "busy" };
  if (!p) return { ok: false, why: "not_found" };
  if (Date.now() / 1000 - p.at > TICKET_TTL_S) return { ok: false, why: "old" };
  if (p.payer !== wallet) return { ok: false, why: "not_yours" };
  // A ticket is for the arena of its exact amount: any other arena refuses it and it stays unused.
  if (p.got !== min) return { ok: false, why: "other_arena" };
  return { ok: true, lamports: p.got };
}

/** The ticket bought a place: it can never be used again (memory now, the ledger line for every instance and restart). */
export function useTicket(sig: string, wallet: string, lamports: number): void {
  usedSigs.set(sig, Date.now());
  gameIn(lamports);
  vaultBal.at = 0;
  void ledger("entry", wallet, lamports, sig);
}

const walletSigs = new Map<string, { at: number; list: string[] }>();
/**
 * The unused tickets of a wallet: its payments to the vault in the last 48 h that never bought a place. Only that wallet's own
 * recent transactions are read (a few, cached), never the whole history of the vault, so the public RPC is not flooded.
 */
export async function ticketsOf(wallet: string, min: number): Promise<{ sig: string; lamports: number; at: number }[]> {
  const { connection } = await chain();
  if (!devnet) return [];
  const cached = walletSigs.get(wallet);
  let list = cached?.list ?? [];
  if (!cached || Date.now() - cached.at > 10_000) {
    try {
      const r = await Promise.race([connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 25 }, "confirmed"), sleep(4000).then(() => { throw new Error("slow"); })]);
      list = r.filter((x) => !x.err && (x.blockTime ?? 0) > Date.now() / 1000 - TICKET_TTL_S).map((x) => x.signature);
      walletSigs.set(wallet, { at: Date.now(), list });
      if (walletSigs.size > 500) walletSigs.delete(walletSigs.keys().next().value!);
    } catch { /* keep the last list */ }
  }
  const unread = list.filter((sig) => !paidCache.has(sig));
  await Promise.race([Promise.all(unread.map((sig) => paidOf(sig, 2))), sleep(3000)]);
  const mine = list.filter((sig) => { const p = paidCache.get(sig); return !!p && p.payer === wallet && p.got >= min; });
  // Which were already used: checked together (a used one is remembered for good).
  const used = await Promise.race([Promise.all(mine.map((sig) => ticketUsed(sig))), sleep(3000).then(() => null)]);
  const out: { sig: string; lamports: number; at: number }[] = [];
  mine.forEach((sig, k) => { if (used && !used[k]) { const p = paidCache.get(sig)!; out.push({ sig, lamports: p.got, at: p.at }); } });
  return out.sort((a, b) => a.at - b.at);
}

/** Pays a cash out from the vault to a wallet. Returns the signature, or null if it could not be sent (logged). */
export async function payOut(wallet: string, lamports: number, bot = false): Promise<string | null> {
  if (!devnet || lamports <= 0) return null;
  try {
    const sig = await send(await initVault(), new PublicKey(wallet), lamports);
    gameOut(lamports);
    vaultBal.at = 0;
    void ledger(bot ? "bot_payout" : "payout", wallet, lamports, sig);
    return sig;
  } catch (e: any) {
    log("cash_payout_failed", { wallet, lamports, error: String(e?.message ?? e).slice(0, 160) });
    return null;
  }
}

/**
 * The vault's own money. The vault holds every entry paid; what the arenas are playing for right now (`inGame`: entries in,
 * payouts out) belongs to the players, and the rest is the house's: its 3% fees and whatever no game holds any more (a restart
 * clears the maps, so their SOL returns to the house). The bots enter with that house money, without a transfer: the SOL is in the
 * vault already, and each bot entry and bot cash out is written to the ledger. A bot only enters when the house can cover it.
 */
let inGame = 0;
let vaultBal = { at: 0, l: 0 };
const RESERVE = 0.03 * LAMPORTS_PER_SOL;
async function vaultBalance(): Promise<number> {
  const { connection } = await chain();
  if (Date.now() - vaultBal.at > 20_000) {
    try { vaultBal = { at: Date.now(), l: await connection.getBalance((await initVault()).publicKey) }; } catch { /* keep the last one */ }
  }
  return vaultBal.l;
}
/** Money that entered a game (a paid entry, a bot entry). */
export function gameIn(l: number): void { inGame += l; }
/** Money that left the games (a payout sent, a bot cash out back to the house). */
export function gameOut(l: number): void { inGame = Math.max(0, inGame - l); }
/** A bot enters with house money when the vault holds more than the games, its reserve and this entry. Returns a ledger id. */
let botSeq = 0;
export async function botEntry(i: number, lamports: number, arena: string): Promise<string | null> {
  if (!devnet) return null;
  const free = (await vaultBalance()) - inGame - RESERVE;
  if (free < lamports) return null;
  inGame += lamports;
  const id = `house-${Date.now().toString(36)}-${(botSeq++).toString(36)}`;
  void ledger("bot_entry", `${arena}:bot${i}`, lamports, id);
  return id;
}
/** A bot cashed out: its SOL goes back to the house (it never left the vault). */
export function botCashOut(i: number, lamports: number, arena: string): void {
  gameOut(lamports);
  void ledger("bot_payout", `${arena}:bot${i}`, lamports, `house-out-${Date.now().toString(36)}-${(botSeq++).toString(36)}`);
}

/** The vault needs some SOL of its own to pay transaction fees: topped up from the server key when it runs low. */
export async function keepVaultAlive(): Promise<void> {
  if (!devnet) return;
  const { connection, authority } = await chain();
  const vault = await initVault();
  try {
    if ((await connection.getBalance(vault.publicKey)) < 0.02 * LAMPORTS_PER_SOL) await send(authority, vault.publicKey, 0.05 * LAMPORTS_PER_SOL);
    // The server key pays the bots' entries: on devnet it asks the faucet for more when it runs low (it may be refused; it tries again later).
    if ((await connection.getBalance(authority.publicKey)) < 0.6 * LAMPORTS_PER_SOL) { try { await connection.requestAirdrop(authority.publicKey, 2 * LAMPORTS_PER_SOL); } catch { /* the faucet said no */ } }
  } catch (e: any) {
    log("cash_vault_topup_failed", { error: String(e?.message ?? e).slice(0, 160) });
  }
}
