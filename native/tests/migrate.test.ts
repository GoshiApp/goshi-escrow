// The v4 config account (140 bytes, no guardian) that is already on devnet moves to the v5 layout in place.
// A local validator starts with a v4 config and vault injected as accounts, no network, no real money.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { GoshiEscrow, decodeConfig, ERRORS, CONFIG_LEN } from "../client/index.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const so = path.resolve(here, process.env.SO ?? "../target/test-deploy/goshi_escrow_native.so");
const programKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(here, "../target/deploy/goshi_escrow_native-keypair.json"), "utf8"))));
const PORT = 18950;
const conn = new Connection(`http://127.0.0.1:${PORT}`, "confirmed");
const g = new GoshiEscrow(programKey.publicKey);
const authority = Keypair.generate();
const guardian = Keypair.generate();
const outsider = Keypair.generate();
const infra = Keypair.generate().publicKey;
const liquidity = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
let validator: ChildProcess;

const run = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
async function expectCode(p: Promise<unknown>, name: string) {
  try {
    await p;
  } catch (e: any) {
    const text = `${e?.message ?? e} ${JSON.stringify(e?.transactionLogs ?? e?.logs ?? "")}`;
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(text);
    assert.equal(ERRORS[m ? parseInt(m[1], 16) : -1], name, text.slice(0, 300));
    return;
  }
  assert.fail(`expected failure ${name}`);
}
const accountFile = (dir: string, name: string, pubkey: PublicKey, data: Uint8Array, owner: PublicKey, lamports: number) => {
  const f = path.join(dir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify({ pubkey: pubkey.toBase58(), account: { lamports, data: [Buffer.from(data).toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length } }));
  return f;
};

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goshi-migrate-"));
  // The v4 config exactly as it is on devnet: tag, authority, infra, liquidity, mint, min holder, required saboteurs, bumps.
  const [cfgKey, cfgBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], programKey.publicKey);
  const [vaultKey, vaultBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault")], programKey.publicKey);
  const cfg = new Uint8Array(140);
  cfg[0] = 1;
  cfg.set(authority.publicKey.toBytes(), 1);
  cfg.set(infra.toBytes(), 33);
  cfg.set(liquidity.toBytes(), 65);
  cfg.set(mint.toBytes(), 97);
  new DataView(cfg.buffer).setBigUint64(129, 100_000_000n, true);
  cfg[137] = 3;
  cfg[138] = cfgBump;
  cfg[139] = vaultBump;
  const vault = new Uint8Array(18);
  vault[0] = 3;
  vault[17] = vaultBump;
  const cfgFile = accountFile(dir, "config", cfgKey, cfg, programKey.publicKey, 1_650_000);
  const vaultFile = accountFile(dir, "vault", vaultKey, vault, programKey.publicKey, 1_000_000);
  validator = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", path.join(dir, "ledger"), "--rpc-port", String(PORT), "--faucet-port", String(PORT + 10),
     "--bpf-program", programKey.publicKey.toBase58(), so, "--account", cfgKey.toBase58(), cfgFile, "--account", vaultKey.toBase58(), vaultFile],
    { stdio: "ignore", env: { ...process.env, COPYFILE_DISABLE: "1" } }
  );
  for (let i = 0; i < 90; i++) {
    try { await conn.getVersion(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  for (const k of [authority, guardian, outsider]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
});

after(() => { validator?.kill("SIGKILL"); });

test("a v4 config is unusable until it is migrated, only its authority migrates it, once, and then the guardian rules", async () => {
  const before = (await conn.getAccountInfo(g.pda.config))!;
  assert.equal(before.data.length, 140);
  assert.equal(decodeConfig(before.data), null, "the new layout does not read the old one by accident");
  // Until the migration the program refuses to use it (a room cannot be created on a half understood config).
  await expectCode(run([g.createRoom(authority.publicKey, 1, LAMPORTS_PER_SOL)], [authority]), "BadAccountData");
  // Not an outsider, not the authority alone, not with a zero guardian.
  await expectCode(run([g.migrateConfig(outsider.publicKey, guardian.publicKey)], [outsider, guardian]), "Unauthorized");
  await run([g.migrateConfig(authority.publicKey, guardian.publicKey)], [authority, guardian]);
  const after_ = (await conn.getAccountInfo(g.pda.config))!;
  assert.equal(after_.data.length, CONFIG_LEN);
  const c = decodeConfig(after_.data)!;
  assert.equal(c.authority.toBase58(), authority.publicKey.toBase58());
  assert.equal(c.guardian.toBase58(), guardian.publicKey.toBase58());
  assert.equal(c.infraWallet.toBase58(), infra.toBase58());
  assert.equal(c.mint.toBase58(), mint.toBase58());
  assert.equal(c.minHolder, 100_000_000n);
  assert.equal(c.requiredSaboteurs, 3);
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(CONFIG_LEN));
  assert.ok(BigInt(after_.lamports) >= rent, "still rent exempt");
  // A second migration has nothing to migrate.
  await expectCode(run([g.migrateConfig(authority.publicKey, outsider.publicKey)], [authority, outsider]), "BadAccountData");
  // And the program works on it: the authority opens a room, the guardian (not the authority) changes the wallets.
  await run([g.createRoom(authority.publicKey, 1, LAMPORTS_PER_SOL)], [authority]);
  await expectCode(run([g.setWallets(authority.publicKey, infra, liquidity)], [authority]), "Unauthorized");
  const newInfra = Keypair.generate().publicKey;
  await run([g.setWallets(guardian.publicKey, newInfra, liquidity)], [guardian]);
  assert.equal(decodeConfig((await conn.getAccountInfo(g.pda.config))!.data)!.infraWallet.toBase58(), newInfra.toBase58());
});
