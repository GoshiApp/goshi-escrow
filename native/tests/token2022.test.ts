// A token created with Token-2022 (what pump.fun creates now) works as the holder token: the program accepts its mint at
// initialization and its token accounts for a saboteur seat. Local validator, no network, no real money.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount, createMint, mintTo } from "@solana/spl-token";
import { GoshiEscrow, decodeRoom, ERRORS } from "../client/index.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const so = path.resolve(here, process.env.SO ?? "../target/test-deploy/goshi_escrow_native.so");
const programKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(here, "../target/deploy/goshi_escrow_native-keypair.json"), "utf8"))));
const PORT = 19010;
const conn = new Connection(`http://127.0.0.1:${PORT}`, "confirmed");
const g = new GoshiEscrow(programKey.publicKey);
const authority = Keypair.generate();
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

before(async () => {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "goshi-t22-"));
  validator = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", ledger, "--rpc-port", String(PORT), "--faucet-port", String(PORT + 10), "--bpf-program", programKey.publicKey.toBase58(), so],
    { stdio: "ignore", env: { ...process.env, COPYFILE_DISABLE: "1" } }
  );
  for (let i = 0; i < 90; i++) {
    try { await conn.getVersion(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
});
after(() => { validator?.kill("SIGKILL"); });

test("a Token-2022 mint initializes the program and its token accounts take saboteur seats", async () => {
  const mint = await createMint(conn, authority, authority.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  const info = await conn.getAccountInfo(mint);
  assert.equal(info!.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  const infra = Keypair.generate().publicKey, liquidity = Keypair.generate().publicKey;
  await run([g.initialize(authority.publicKey, infra, liquidity, mint, 100_000_000n, 3)], [authority]);

  const rich = Keypair.generate(), poor = Keypair.generate();
  for (const k of [rich, poor]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), "confirmed");
  const richToken = await createAccount(conn, authority, mint, rich.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
  const poorToken = await createAccount(conn, authority, mint, poor.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(conn, authority, mint, richToken, authority, 500_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(conn, authority, mint, poorToken, authority, 1_000n, [], undefined, TOKEN_2022_PROGRAM_ID);

  await run([g.createRoom(authority.publicKey, 1, LAMPORTS_PER_SOL)], [authority]);
  await expectCode(run([g.joinFree(poor.publicKey, 1, poorToken)], [poor]), "NotEnoughGoshi");
  await run([g.joinFree(rich.publicKey, 1, richToken)], [rich]);
  const room = decodeRoom((await conn.getAccountInfo(g.pda.room(1)))!.data)!;
  assert.deepEqual(room.free.map((k) => k.toBase58()), [rich.publicKey.toBase58()]);
});
