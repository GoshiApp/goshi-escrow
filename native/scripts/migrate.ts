// Moves the config account of an already initialized program (v4, 140 bytes) to the v5 layout and names the guardian.
//   RPC_URL=https://api.devnet.solana.com WALLET=../.devnet-wallet.json GUARDIAN_KEYPAIR=../.devnet-guardian.json \
//   PROGRAM_KEYPAIR=target/deploy/goshi_escrow_native-keypair.json npx tsx scripts/migrate.ts
// WALLET is the authority recorded in the config and pays. GUARDIAN_KEYPAIR signs too, so it must be a key you hold (the cold one).
import fs from "node:fs";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { GoshiEscrow, decodeConfig, CONFIG_LEN } from "../client/index.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const conn = new Connection(env("RPC_URL"), "confirmed");
const wallet = load(env("WALLET"));
const guardian = load(env("GUARDIAN_KEYPAIR"));
const g = new GoshiEscrow(load(env("PROGRAM_KEYPAIR")).publicKey);

const before = await conn.getAccountInfo(g.pda.config);
if (!before) throw new Error("the program is not initialized");
if (before.data.length === CONFIG_LEN) throw new Error("already on the new layout");
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(g.migrateConfig(wallet.publicKey, guardian.publicKey)), [wallet, guardian], { commitment: "confirmed" });
const after = decodeConfig((await conn.getAccountInfo(g.pda.config))!.data)!;
console.log(JSON.stringify({ signature: sig, authority: after.authority.toBase58(), guardian: after.guardian.toBase58() }, null, 2));
