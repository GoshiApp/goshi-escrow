// Integration tests for the native program on a local validator (spawned here, no network, no real money).
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createAccount, createMint, mintTo } from "@solana/spl-token";
import { GoshiEscrow, decodeConfig, decodeRoom, decodeTraps, decodeVault, ERRORS, TRAP_FLUSH_MIN } from "../client/index.ts";

const SOL = BigInt(LAMPORTS_PER_SOL);
const pct = (a: bigint, p: bigint) => (a * p) / 100n;
const here = path.dirname(new URL(import.meta.url).pathname);
// The tests of the refund timeout need the build made with `--features short-refund` (4 seconds instead of 3 hours).
const so = path.resolve(here, process.env.SO ?? "../target/test-deploy/goshi_escrow_native.so");
const programKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(here, "../target/deploy/goshi_escrow_native-keypair.json"), "utf8"))));
const PORT = 18899;
const conn = new Connection(`http://127.0.0.1:${PORT}`, "confirmed");
const g = new GoshiEscrow(programKey.publicKey);

let validator: ChildProcess;
const authority = Keypair.generate();
const guardian = Keypair.generate();
const infra = Keypair.generate();
const liquidity = Keypair.generate();
const outsider = Keypair.generate();
const passHolder = Keypair.generate();
const paid: Keypair[] = [];
const free: Keypair[] = [];
const freeTokens: PublicKey[] = [];
let mint: PublicKey;
const MIN_HOLD = 100_000_000n;
let nextRoom = 100;

const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k));
async function fund(k: PublicKey, sol: number) {
  await conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
}
async function run(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function expectCode(p: Promise<unknown>, name: string) {
  try {
    await p;
  } catch (e: any) {
    const text = `${e?.message ?? e} ${JSON.stringify(e?.transactionLogs ?? e?.logs ?? "")}`;
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(text) ?? /"Custom":(\d+)/.exec(text);
    const code = m ? (text.includes("0x") && /0x/.test(m[0]) ? parseInt(m[1], 16) : Number(m[1])) : -1;
    assert.equal(ERRORS[code], name, `expected ${name}, got ${ERRORS[code] ?? code}: ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected failure ${name}`);
}
const room = (id: number) => g.pda.room(id);
async function getRoom(id: number) {
  const a = await conn.getAccountInfo(room(id));
  return a ? decodeRoom(a.data) : null;
}
async function newRoom(fee: bigint) {
  const id = nextRoom++;
  await run([g.createRoom(authority.publicKey, id, fee)], [authority]);
  return id;
}

before(async () => {
  assert.ok(fs.existsSync(so), "build the program first: npm run build");
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "goshi-native-"));
  validator = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", ledger, "--rpc-port", String(PORT), "--faucet-port", String(PORT + 10),
     "--bpf-program", programKey.publicKey.toBase58(), so],
    { stdio: "ignore", env: { ...process.env, COPYFILE_DISABLE: "1" } }
  );
  for (let i = 0; i < 90; i++) {
    try {
      await conn.getVersion();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  for (const k of [authority, guardian, infra, liquidity, outsider, passHolder]) await fund(k.publicKey, 20);
  mint = await createMint(conn, authority, authority.publicKey, null, 6);
  for (let i = 0; i < 10; i++) {
    const k = Keypair.generate();
    await fund(k.publicKey, 12);
    paid.push(k);
  }
  for (let i = 0; i < 3; i++) {
    const k = Keypair.generate();
    await fund(k.publicKey, 2);
    const ata = await createAccount(conn, authority, mint, k.publicKey, Keypair.generate());
    await mintTo(conn, authority, mint, ata, authority, 500_000_000n);
    free.push(k);
    freeTokens.push(ata);
  }
});

after(() => {
  validator?.kill("SIGKILL");
});

describe("goshi-escrow native", () => {
  test("initializes once, even when somebody sent lamports to its addresses first, and rejects a second initialization", async () => {
    // Anybody can send lamports to a PDA address before it exists. That must not be able to block the initialization.
    await run([SystemProgram.transfer({ fromPubkey: outsider.publicKey, toPubkey: g.pda.config, lamports: 5_000_000 })], [outsider]);
    await run([SystemProgram.transfer({ fromPubkey: outsider.publicKey, toPubkey: g.pda.vault, lamports: 1_000_000 })], [outsider]);
    await run([g.initialize(authority.publicKey, infra.publicKey, liquidity.publicKey, mint, MIN_HOLD, 3, guardian.publicKey)], [authority]);
    const cfg = decodeConfig((await conn.getAccountInfo(g.pda.config))!.data)!;
    assert.equal(cfg.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(cfg.guardian.toBase58(), guardian.publicKey.toBase58());
    assert.equal(cfg.requiredSaboteurs, 3);
    assert.equal(cfg.minHolder, MIN_HOLD);
    await expectCode(
      run([g.initialize(authority.publicKey, infra.publicKey, liquidity.publicKey, mint, MIN_HOLD, 3)], [authority]),
      "AlreadyInitialized"
    );
  });

  test("a room address that already holds lamports can still be created", async () => {
    const id = nextRoom++;
    await run([SystemProgram.transfer({ fromPubkey: outsider.publicKey, toPubkey: room(id), lamports: 1_000_000 })], [outsider]);
    await run([g.createRoom(authority.publicKey, id, SOL)], [authority]);
    const r = await getRoom(id);
    assert.ok(r && r.entryFee === SOL && r.state === "waiting");
    assert.ok(r!.createdAt > 0n);
    await run([g.cancelRoom(authority.publicKey, id, [])], [authority]);
  });

  test("only the authority creates rooms", async () => {
    await expectCode(run([g.createRoom(outsider.publicKey, 999, SOL)], [outsider]), "Unauthorized");
  });

  test("a full room: waits for the saboteurs, then pays 95/2/3 exactly and closes", async () => {
    const fee = SOL;
    const id = await newRoom(fee);
    for (let i = 0; i < 10; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    let r = (await getRoom(id))!;
    assert.equal(r.paid.length, 10);
    assert.equal(r.state, "waiting");

    const poor = Keypair.generate();
    await fund(poor.publicKey, 1);
    const poorToken = await createAccount(conn, authority, mint, poor.publicKey, Keypair.generate());
    await mintTo(conn, authority, mint, poorToken, authority, 10_000n);
    await expectCode(run([g.joinFree(poor.publicKey, id, poorToken)], [poor]), "NotEnoughGoshi");
    // A token account that belongs to somebody else does not count.
    await expectCode(run([g.joinFree(free[0].publicKey, id, poorToken)], [free[0]]), "NotEnoughGoshi");

    for (let i = 0; i < 3; i++) await run([g.joinFree(free[i].publicKey, id, freeTokens[i])], [free[i]]);
    r = (await getRoom(id))!;
    assert.equal(r.state, "active");
    assert.equal(r.free.length, 3);

    await expectCode(run([g.joinRoom(outsider.publicKey, id)], [outsider]), "RoomNotWaiting");
    const sab = free.map((k) => k.publicKey);
    const podium = [paid[3].publicKey, paid[7].publicKey, paid[1].publicKey];
    await expectCode(run([g.finalizeRoyale(outsider.publicKey, id, infra.publicKey, liquidity.publicKey, podium, sab)], [outsider]), "Unauthorized");
    await expectCode(run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, [paid[3].publicKey, paid[3].publicKey, paid[1].publicKey], sab)], [authority]), "DuplicateWinners");
    await expectCode(run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, [paid[3].publicKey, free[0].publicKey, paid[1].publicKey], sab)], [authority]), "WinnerNotInRoom");

    const before = { p: await Promise.all(podium.map(bal)), s: await Promise.all(sab.map(bal)), infra: await bal(infra.publicKey), liq: await bal(liquidity.publicKey), vault: await bal(g.pda.vault) };
    await run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, podium, sab)], [authority]);

    const nominal = 10n * fee;
    const pool = pct(nominal, 95n);
    const first = pct(pool, 60n);
    const second = pct(pool, 25n);
    const third = pool - first - second;
    const each = pct(nominal, 2n) / 3n;
    const rake = nominal - pool - each * 3n;
    const burn = pct(rake, 10n);
    const inf = pct(rake, 15n);
    const liq = pct(rake, 25n);
    const jackpot = rake - burn - inf - liq;
    const after_ = await Promise.all(podium.map(bal));
    assert.equal(after_[0] - before.p[0], first);
    assert.equal(after_[1] - before.p[1], second);
    assert.equal(after_[2] - before.p[2], third);
    for (let i = 0; i < 3; i++) assert.equal((await bal(sab[i])) - before.s[i], each);
    assert.equal((await bal(infra.publicKey)) - before.infra, inf);
    assert.equal((await bal(liquidity.publicKey)) - before.liq, liq);
    assert.equal((await bal(g.pda.vault)) - before.vault, burn + jackpot);
    assert.equal(await getRoom(id), null, "room closed");
    const v = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
    assert.equal(v.openBurn + v.openJackpot, burn + jackpot);
  });

  test("v7 bags: every paid seat gets its bag, the house 3 percent, the unpaid rest to the jackpot", async () => {
    const fee = SOL;
    const id = await newRoom(fee);
    for (let i = 0; i < 10; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    for (let i = 0; i < 3; i++) await run([g.joinFree(free[i].publicKey, id, freeTokens[i])], [free[i]]);
    const seats = paid.map((k) => k.publicKey);
    const cash = 10n * fee;
    const pool = cash - pct(cash, 3n);
    const tooBig = seats.map(() => pool / 10n + 1n);
    await expectCode(run([g.finalizeBags(authority.publicKey, id, infra.publicKey, liquidity.publicKey, seats, tooBig)], [authority]), "BagsTooBig");
    await expectCode(run([g.finalizeBags(outsider.publicKey, id, infra.publicKey, liquidity.publicKey, seats, seats.map(() => 0n))], [outsider]), "Unauthorized");
    const swapped = [...seats]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    await expectCode(run([g.finalizeBags(authority.publicKey, id, infra.publicKey, liquidity.publicKey, swapped, seats.map(() => 0n))], [authority]), "WrongAccount");
    const bags = seats.map((_, i) => (i < 3 ? pool / 4n : 0n));
    const left = pool - (pool / 4n) * 3n;
    const before = { p: await Promise.all(seats.map(bal)), infra: await bal(infra.publicKey), liq: await bal(liquidity.publicKey), vault: await bal(g.pda.vault) };
    await run([g.finalizeBags(authority.publicKey, id, infra.publicKey, liquidity.publicKey, seats, bags)], [authority]);
    for (let i = 0; i < 10; i++) assert.equal((await bal(seats[i])) - before.p[i], bags[i]);
    const rake = cash - pool;
    const burn = pct(rake, 10n), inf = pct(rake, 15n), liq = pct(rake, 25n);
    assert.equal((await bal(infra.publicKey)) - before.infra, inf);
    assert.equal((await bal(liquidity.publicKey)) - before.liq, liq);
    assert.equal((await bal(g.pda.vault)) - before.vault, rake - inf - liq + left);
    assert.equal(await getRoom(id), null, "room closed");
  });

  test("proof logs: the commit at create_room and the proof at finalize, with no extra account", async () => {
    const commit = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const id = nextRoom++;
    const sig1 = await run([g.createRoom(authority.publicKey, id, SOL, commit)], [authority]);
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const logsOf = async (sig: string) => (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages!;
    let logs = await logsOf(sig1);
    const dataLines = logs.filter((l) => l.startsWith("Program data:"));
    assert.equal(dataLines.length, 1);
    assert.ok(dataLines[0].includes(b64(new TextEncoder().encode("goshi:commit"))));
    assert.ok(dataLines[0].includes(b64(commit)));

    for (let i = 0; i < 10; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    for (let i = 0; i < 3; i++) await run([g.joinFree(free[i].publicKey, id, freeTokens[i])], [free[i]]);
    const proof = {
      seedReveal: Uint8Array.from({ length: 32 }, () => 7),
      blockhash: Uint8Array.from({ length: 32 }, () => 6),
      snapshotHash: Uint8Array.from({ length: 32 }, () => 8),
      replayRoot: Uint8Array.from({ length: 32 }, () => 9),
    };
    const sig2 = await run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, paid.slice(0, 3).map((k) => k.publicKey), free.map((k) => k.publicKey), proof)], [authority]);
    logs = await logsOf(sig2);
    const l2 = logs.filter((l) => l.startsWith("Program data:"));
    assert.equal(l2.length, 1);
    for (const part of [proof.seedReveal, proof.blockhash, proof.snapshotHash, proof.replayRoot]) assert.ok(l2[0].includes(b64(part)));
    assert.equal(await getRoom(id), null);
  });

  test("pass seat: only with nine paid, once, by the authority; settles exactly; cancel skips the holder", async () => {
    const fee = 2n * SOL;
    const id = await newRoom(fee);
    for (let i = 0; i < 8; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    await expectCode(run([g.joinWithPass(authority.publicKey, passHolder.publicKey, id)], [authority]), "BadPlayerCount");
    await run([g.joinRoom(paid[8].publicKey, id)], [paid[8]]);
    await expectCode(run([g.joinWithPass(outsider.publicKey, passHolder.publicKey, id)], [outsider]), "Unauthorized");
    await expectCode(run([g.joinWithPass(authority.publicKey, paid[0].publicKey, id)], [authority]), "AlreadyJoined");
    for (let i = 0; i < 3; i++) await run([g.joinFree(free[i].publicKey, id, freeTokens[i])], [free[i]]);
    await run([g.joinWithPass(authority.publicKey, passHolder.publicKey, id)], [authority]);
    const r = (await getRoom(id))!;
    assert.equal(r.paid.length, 10);
    assert.equal(r.passes, 1);
    assert.equal(r.state, "active");
    const held = await bal(room(id));
    const rent = BigInt(await conn.getMinimumBalanceForRentExemption(567));
    assert.equal(held - rent, 9n * fee, "only nine entries are inside");

    const podium = [passHolder.publicKey, paid[2].publicKey, paid[5].publicKey];
    const first = pct(pct(9n * fee, 95n), 60n); // v6: the prizes come from the nine entries the room holds
    const b = await bal(passHolder.publicKey);
    await run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, podium, free.map((k) => k.publicKey))], [authority]);
    assert.equal((await bal(passHolder.publicKey)) - b, first);
    assert.equal(await getRoom(id), null);

    // Cancel with a pass seat refunds only the real payers.
    const cid = await newRoom(fee);
    for (let i = 0; i < 9; i++) await run([g.joinRoom(paid[i].publicKey, cid)], [paid[i]]);
    await run([g.joinWithPass(authority.publicKey, passHolder.publicKey, cid)], [authority]);
    assert.equal((await getRoom(cid))!.passes, 1);
    const refunds = paid.slice(0, 9).map((k) => k.publicKey);
    const before = await Promise.all(refunds.map(bal));
    const holderBefore = await bal(passHolder.publicKey);
    await run([g.cancelRoom(authority.publicKey, cid, refunds)], [authority]);
    for (let i = 0; i < 9; i++) assert.equal((await bal(refunds[i])) - before[i], fee);
    assert.equal(await bal(passHolder.publicKey), holderBefore);
    assert.equal(await getRoom(cid), null);
  });

  test("the guardian can lower the required saboteurs and a room starts without them", async () => {
    await expectCode(run([g.setRequiredSaboteurs(authority.publicKey, 0)], [authority]), "Unauthorized");
    await run([g.setRequiredSaboteurs(guardian.publicKey, 0)], [guardian]);
    const id = await newRoom(SOL);
    for (let i = 0; i < 10; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    assert.equal((await getRoom(id))!.state, "active");
    const infraBefore = await bal(infra.publicKey);
    await run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, paid.slice(0, 3).map((k) => k.publicKey), [])], [authority]);
    const rake = 10n * SOL - pct(10n * SOL, 95n);
    assert.equal((await bal(infra.publicKey)) - infraBefore, pct(rake, 15n));
    await run([g.setRequiredSaboteurs(guardian.publicKey, 3)], [guardian]);
  });

  test("VS: losers keep 80% of the net entry, the winner takes the rest", async () => {
    const id = await newRoom(SOL);
    for (let i = 0; i < 3; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    await run([g.startVs(authority.publicKey, id)], [authority]);
    const ranking = [paid[2].publicKey, paid[0].publicKey, paid[1].publicKey];
    const before = await Promise.all(ranking.map(bal));
    await run([g.finalizeVs(authority.publicKey, id, infra.publicKey, liquidity.publicKey, ranking)], [authority]);
    const pot = 3n * SOL;
    const loser = pct(SOL - pct(SOL, 3n), 80n);
    assert.equal((await bal(ranking[0])) - before[0], pot - pct(pot, 3n) - 2n * loser);
    assert.equal((await bal(ranking[1])) - before[1], loser);
    assert.equal((await bal(ranking[2])) - before[2], loser);
    assert.equal(await getRoom(id), null);
  });

  test("Duel: the winner takes the pot minus 3 percent, a loser cannot be named, more than five is refused", async () => {
    const id = await newRoom(SOL);
    for (let i = 0; i < 3; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    await run([g.startDuel(authority.publicKey, id)], [authority]);
    // a wallet that is not in the room cannot win
    await expectCode(run([g.finalizeDuel(authority.publicKey, id, infra.publicKey, liquidity.publicKey, paid[8].publicKey)], [authority]), "WinnerNotInRoom");
    const before = await bal(paid[1].publicKey);
    await run([g.finalizeDuel(authority.publicKey, id, infra.publicKey, liquidity.publicKey, paid[1].publicKey)], [authority]);
    const pot = 3n * SOL;
    assert.equal((await bal(paid[1].publicKey)) - before, pot - pct(pot, 3n));
    assert.equal(await getRoom(id), null);
    // six players is not a duel
    const big = await newRoom(SOL);
    for (let i = 0; i < 6; i++) await run([g.joinRoom(paid[i].publicKey, big)], [paid[i]]);
    await expectCode(run([g.startDuel(authority.publicKey, big)], [authority]), "BadPlayerCount");
    await run([g.cancelRoom(authority.publicKey, big, paid.slice(0, 6).map((p) => p.publicKey))], [authority]);
  });

  test("a private duel by contract: only the invited wallets sit, the host signs and pays, then the winner takes the pot", async () => {
    const host = paid[0], friend = paid[1], stranger = paid[2];
    const id = BigInt(Date.now()) * 1000n + 7n;
    const commit = new Uint8Array(32).fill(7);
    const before = await bal(host.publicKey);
    await run([g.createDuel(authority.publicKey, host.publicKey, id, SOL, commit, [friend.publicKey])], [authority, host]);
    const r = decodeRoom((await conn.getAccountInfo(g.pda.room(id)))!.data)!;
    assert.equal(r.mode, "duel");
    assert.equal(r.paid.length, 1);
    assert.equal(r.paid[0].toBase58(), host.publicKey.toBase58());
    assert.deepEqual(r.guests.map((k) => k.toBase58()), [friend.publicKey.toBase58()]);
    assert.ok((await bal(host.publicKey)) <= before - SOL);
    // Somebody who was not invited cannot take a seat, not as a paid player nor as a saboteur.
    await expectCode(run([g.joinRoom(stranger.publicKey, id)], [stranger]), "Unauthorized");
    await expectCode(run([g.joinFree(stranger.publicKey, id, await createAccount(conn, authority, mint, stranger.publicKey, Keypair.generate()))], [stranger]), "RoomNotWaiting");
    await run([g.joinRoom(friend.publicKey, id)], [friend]);
    await run([g.startDuel(authority.publicKey, id)], [authority]);
    const b2 = await bal(friend.publicKey);
    await run([g.finalizeDuel(authority.publicKey, id, infra.publicKey, liquidity.publicKey, friend.publicKey)], [authority]);
    assert.equal((await bal(friend.publicKey)) - b2, 2n * SOL - pct(2n * SOL, 3n));
    assert.equal(await getRoom(id), null);
  });

  test("a stolen hot key cannot touch the wallets, the settings, the vault or the roles; the guardian can replace it", async () => {
    const next = Keypair.generate();
    const newInfra = Keypair.generate().publicKey;
    const dest = Keypair.generate();
    await fund(dest.publicKey, 1);
    // Not a stranger, and not the authority either: the house wallets and the roles belong to the guardian.
    await expectCode(run([g.setWallets(paid[0].publicKey, newInfra, liquidity.publicKey)], [paid[0]]), "Unauthorized");
    await expectCode(run([g.setWallets(authority.publicKey, newInfra, liquidity.publicKey)], [authority]), "Unauthorized");
    await expectCode(run([g.setMinHolder(authority.publicKey, 1n)], [authority]), "Unauthorized");
    await expectCode(run([g.withdrawVault(authority.publicKey, dest.publicKey, 1n)], [authority]), "Unauthorized");
    await expectCode(run([g.setAuthority(authority.publicKey, outsider.publicKey)], [authority, outsider]), "Unauthorized");
    await expectCode(run([g.setGuardian(authority.publicKey, outsider.publicKey)], [authority, outsider]), "Unauthorized");
    // The guardian changes the wallets and puts them back.
    await run([g.setWallets(guardian.publicKey, newInfra, liquidity.publicKey)], [guardian]);
    assert.equal(decodeConfig((await conn.getAccountInfo(g.pda.config))!.data)!.infraWallet.toBase58(), newInfra.toBase58());
    await run([g.setWallets(guardian.publicKey, infra.publicKey, liquidity.publicKey)], [guardian]);
    // The new authority signs too (no typos), the old one does not: a lost hot key is replaced without its help.
    await run([g.setAuthority(guardian.publicKey, next.publicKey)], [guardian, next]);
    await expectCode(run([g.createRoom(authority.publicKey, nextRoom++, SOL)], [authority]), "Unauthorized");
    await run([g.createRoom(next.publicKey, nextRoom++, SOL)], [authority, next]).catch(() => undefined);
    await run([g.setAuthority(guardian.publicKey, authority.publicKey)], [guardian, authority]);
    // The guardian role itself moves only with both keys (the new one signs too).
    const guard2 = Keypair.generate();
    await run([g.setGuardian(guardian.publicKey, guard2.publicKey)], [guardian, guard2]);
    await expectCode(run([g.setWallets(guardian.publicKey, infra.publicKey, liquidity.publicKey)], [guardian]), "Unauthorized");
    await run([g.setGuardian(guard2.publicKey, guardian.publicKey)], [guardian, guard2]);
  });

  test("a payout that would leave a wallet below the rent minimum goes to the vault instead of blocking the settlement", async () => {
    await run([g.setRequiredSaboteurs(guardian.publicKey, 3)], [guardian]);
    const fee = 6_000_000n; // a 1 USD room: a saboteur's share is 400,000 lamports, under the 890,880 of the rent minimum
    const id = await newRoom(fee);
    for (let i = 0; i < 10; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    // Three saboteurs; the first one empties its wallet after taking the seat (anybody else pays the transaction fees).
    const sabs: Keypair[] = [];
    for (let i = 0; i < 3; i++) {
      const k = Keypair.generate();
      await fund(k.publicKey, 1);
      const ata = await createAccount(conn, authority, mint, k.publicKey, Keypair.generate());
      await mintTo(conn, authority, mint, ata, authority, 500_000_000n);
      await run([g.joinFree(k.publicKey, id, ata)], [authority, k]);
      sabs.push(k);
    }
    const left = await conn.getBalance(sabs[0].publicKey);
    await run([SystemProgram.transfer({ fromPubkey: sabs[0].publicKey, toPubkey: outsider.publicKey, lamports: left })], [authority, sabs[0]]);
    assert.equal(await bal(sabs[0].publicKey), 0n);
    const podium = paid.slice(0, 3).map((k) => k.publicKey);
    const v0 = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
    const b1 = await bal(sabs[1].publicKey);
    await run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, podium, sabs.map((k) => k.publicKey))], [authority]);
    const each = pct(10n * fee, 2n) / 3n;
    assert.equal(await bal(sabs[0].publicKey), 0n, "the empty wallet got nothing");
    assert.equal((await bal(sabs[1].publicKey)) - b1, each, "the others were paid");
    assert.equal(await getRoom(id), null, "and the room settled");
    // The share that could not be paid is in the super pot.
    const nominal = 10n * fee;
    const pool = pct(nominal, 95n);
    const rake = nominal - pool - each * 3n;
    const jackpot = rake - pct(rake, 10n) - pct(rake, 15n) - pct(rake, 25n);
    const v1 = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
    assert.equal(v1.openJackpot - v0.openJackpot, jackpot + each);
  });

  test("anybody can refund an expired room; before the timeout nobody can", async () => {
    const id = await newRoom(SOL);
    for (let i = 0; i < 4; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    const refunds = paid.slice(0, 4).map((k) => k.publicKey);
    await expectCode(run([g.refundExpired(outsider.publicKey, id, authority.publicKey, refunds)], [outsider]), "TooEarly");
    await new Promise((r) => setTimeout(r, 6000));
    const before = await Promise.all(refunds.map(bal));
    // Not to somebody else's address: the rent goes back to the authority and the refunds to the payers, in order.
    await expectCode(run([g.refundExpired(outsider.publicKey, id, outsider.publicKey, refunds)], [outsider]), "WrongAccount");
    await expectCode(run([g.refundExpired(outsider.publicKey, id, authority.publicKey, [...refunds].reverse())], [outsider]), "WrongAccount");
    const authBefore = await bal(authority.publicKey);
    await run([g.refundExpired(outsider.publicKey, id, authority.publicKey, refunds)], [outsider]);
    for (let i = 0; i < 4; i++) assert.equal((await bal(refunds[i])) - before[i], SOL);
    assert.ok((await bal(authority.publicKey)) > authBefore, "the rent came back to the authority");
    assert.equal(await getRoom(id), null);
  });

  test("the room records the slot in which it became active and the proof log carries it", async () => {
    const id = await newRoom(SOL);
    for (let i = 0; i < 9; i++) await run([g.joinRoom(paid[i].publicKey, id)], [paid[i]]);
    assert.equal((await getRoom(id))!.activeSlot, 0n, "still waiting");
    await run([g.setRequiredSaboteurs(guardian.publicKey, 0)], [guardian]);
    const sig = await run([g.joinRoom(paid[9].publicKey, id)], [paid[9]]);
    const r = (await getRoom(id))!;
    assert.equal(r.state, "active");
    const tx = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!;
    assert.equal(r.activeSlot, BigInt(tx.slot), "the slot of the transaction that filled the room");
    const proof = {
      seedReveal: new Uint8Array(32).fill(1), blockhash: new Uint8Array(32).fill(2), snapshotHash: new Uint8Array(32).fill(3), replayRoot: new Uint8Array(32).fill(4),
    };
    const sig2 = await run([g.finalizeRoyale(authority.publicKey, id, infra.publicKey, liquidity.publicKey, paid.slice(0, 3).map((k) => k.publicKey), [], proof)], [authority]);
    const line = (await conn.getTransaction(sig2, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages!.find((l) => l.startsWith("Program data:"))!;
    const parts = line.replace("Program data: ", "").split(" ").map((x) => Buffer.from(x, "base64"));
    assert.equal(parts.length, 7, "kind, room id, four proof parts and the slot");
    assert.equal(parts[6].readBigUInt64LE(0), BigInt(tx.slot));
    await run([g.setRequiredSaboteurs(guardian.publicKey, 3)], [guardian]);
  });

  test("a VS match needs two paid players; cancel refunds everyone", async () => {
    const id = await newRoom(SOL);
    await run([g.joinRoom(paid[6].publicKey, id)], [paid[6]]);
    await expectCode(run([g.startVs(authority.publicKey, id)], [authority]), "BadPlayerCount");
    await run([g.joinRoom(paid[7].publicKey, id)], [paid[7]]);
    const b = [await bal(paid[6].publicKey), await bal(paid[7].publicKey)];
    await run([g.cancelRoom(authority.publicKey, id, [paid[6].publicKey, paid[7].publicKey])], [authority]);
    assert.equal((await bal(paid[6].publicKey)) - b[0], SOL);
    assert.equal((await bal(paid[7].publicKey)) - b[1], SOL);
  });

  test("a double join and a wrong room id are refused", async () => {
    const id = await newRoom(SOL);
    await run([g.joinRoom(paid[0].publicKey, id)], [paid[0]]);
    await expectCode(run([g.joinRoom(paid[0].publicKey, id)], [paid[0]]), "AlreadyJoined");
    await run([g.cancelRoom(authority.publicKey, id, [paid[0].publicKey])], [authority]);
  });

  test("manual vault withdrawal: only the guardian, never more than pending", async () => {
    const v0 = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
    const pending = v0.openBurn + v0.openJackpot;
    assert.ok(pending > 0n);
    const dest = Keypair.generate();
    await fund(dest.publicKey, 1);
    await expectCode(run([g.withdrawVault(outsider.publicKey, dest.publicKey, pending)], [outsider]), "Unauthorized");
    await expectCode(run([g.withdrawVault(authority.publicKey, dest.publicKey, pending)], [authority]), "Unauthorized");
    await expectCode(run([g.withdrawVault(guardian.publicKey, dest.publicKey, pending + 1n)], [guardian]), "NothingPending");
    const before = await bal(dest.publicKey);
    await run([g.withdrawVault(guardian.publicKey, dest.publicKey, pending)], [guardian]);
    assert.equal((await bal(dest.publicKey)) - before, pending);
    const v1 = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
    assert.equal(v1.openBurn + v1.openJackpot, 0n);
  });
  test("v6 backpacks: kept apart from the pot, capped at the entry, spent part to the trap pots, the rest back", async () => {
    const fee = SOL / 10n;
    const id = await newRoom(fee);
    const p = paid.slice(0, 3);
    await expectCode(run([g.joinRoom(p[0].publicKey, id, fee + 1n)], [p[0]]), "BadBackpack");
    await run([g.joinRoom(p[0].publicKey, id, fee)], [p[0]]);
    await run([g.joinRoom(p[1].publicKey, id, fee / 2n)], [p[1]]);
    await run([g.joinRoom(p[2].publicKey, id)], [p[2]]);
    const r = (await getRoom(id))!;
    assert.deepEqual(r.backpacks, [fee, fee / 2n, 0n]);
    await run([g.startVs(authority.publicKey, id)], [authority]);
    const ranking = p.map((k) => k.publicKey);
    await expectCode(run([g.finalizeVs(authority.publicKey, id, infra.publicKey, liquidity.publicKey, ranking)], [authority]), "BackpackOpen");
    await expectCode(run([g.settleBackpacks(authority.publicKey, id, ranking, [fee + 1n, 0n, 0n])], [authority]), "BadBackpack");
    await expectCode(run([g.settleBackpacks(outsider.publicKey, id, ranking, [0n, 0n, 0n])], [outsider]), "Unauthorized");
    const before = await Promise.all(ranking.map(bal));
    const t0 = (await conn.getAccountInfo(g.pda.traps)) ? decodeTraps((await conn.getAccountInfo(g.pda.traps))!.data)! : { maintenance: 0n, project: 0n };
    const spent = [fee / 10n, fee / 20n, 0n];
    await run([g.settleBackpacks(authority.publicKey, id, ranking, spent)], [authority]);
    const after_ = await Promise.all(ranking.map(bal));
    assert.equal(after_[0] - before[0], fee - fee / 10n);
    assert.equal(after_[1] - before[1], fee / 2n - fee / 20n);
    assert.equal(after_[2] - before[2], 0n);
    const t1 = decodeTraps((await conn.getAccountInfo(g.pda.traps))!.data)!;
    const total = spent[0] + spent[1];
    assert.equal(t1.maintenance - t0.maintenance, total / 2n);
    assert.equal(t1.project - t0.project, total - total / 2n);
    // Now the room settles as usual, and the pot never saw the backpacks.
    const b2 = await Promise.all(ranking.map(bal));
    await run([g.finalizeVs(authority.publicKey, id, infra.publicKey, liquidity.publicKey, ranking)], [authority]);
    const loser = pct(fee - pct(fee, 3n), 80n);
    assert.equal((await bal(ranking[1])) - b2[1], loser);
    assert.equal(await getRoom(id), null);
  });

  test("v6 backpacks: cancel gives the entry and the whole backpack back", async () => {
    const fee = SOL / 10n;
    const id = await newRoom(fee);
    const b = await bal(paid[4].publicKey);
    await run([g.joinRoom(paid[4].publicKey, id, fee / 4n)], [paid[4]]);
    await run([g.cancelRoom(authority.publicKey, id, [paid[4].publicKey])], [authority]);
    assert.ok(b - (await bal(paid[4].publicKey)) < 20_000n, "only the network fee is gone");
  });

  test("v6 trap pots: paid only above the minimum, only to the config wallets, by the authority or the guardian", async () => {
    await expectCode(run([g.flushTraps(outsider.publicKey, infra.publicKey, liquidity.publicKey)], [outsider]), "Unauthorized");
    await expectCode(run([g.flushTraps(authority.publicKey, outsider.publicKey, liquidity.publicKey)], [authority]), "WrongAccount");
    const t = decodeTraps((await conn.getAccountInfo(g.pda.traps))!.data)!;
    assert.ok(t.maintenance < TRAP_FLUSH_MIN && t.project < TRAP_FLUSH_MIN);
    await expectCode(run([g.flushTraps(authority.publicKey, infra.publicKey, liquidity.publicKey)], [authority]), "NothingPending");
    // Fill the pots past the minimum with a room where everybody spends the whole backpack.
    const fee = SOL / 5n;
    const id = await newRoom(fee);
    const p = paid.slice(5, 7);
    for (const k of p) await run([g.joinRoom(k.publicKey, id, fee)], [k]);
    await run([g.startVs(authority.publicKey, id)], [authority]);
    await run([g.settleBackpacks(authority.publicKey, id, p.map((k) => k.publicKey), [fee, fee])], [authority]);
    const t2 = decodeTraps((await conn.getAccountInfo(g.pda.traps))!.data)!;
    const bi = await bal(infra.publicKey), bl = await bal(liquidity.publicKey);
    await run([g.flushTraps(guardian.publicKey, infra.publicKey, liquidity.publicKey)], [guardian]);
    assert.equal((await bal(infra.publicKey)) - bi, t2.maintenance);
    assert.equal((await bal(liquidity.publicKey)) - bl, t2.project);
    const t3 = decodeTraps((await conn.getAccountInfo(g.pda.traps))!.data)!;
    assert.deepEqual([t3.maintenance, t3.project], [0n, 0n]);
    await run([g.finalizeVs(authority.publicKey, id, infra.publicKey, liquidity.publicKey, p.map((k) => k.publicKey))], [authority]);
  });
});
