// One-off setup of the native program: initializes the config PDA and writes the public addresses.
// Devnet:  RPC_URL=https://api.devnet.solana.com WALLET=../.devnet-wallet.json PROGRAM_KEYPAIR=target/deploy/goshi_escrow_native-keypair.json \
//          OUT=../devnet-config.json MINT=<mint> INFRA=<wallet> LIQUIDITY=<wallet> npx tsx scripts/setup.ts
// Mainnet additionally needs I_UNDERSTAND_THIS_IS_MAINNET=yes. REQUIRED_SABOTEURS=0 while nobody can hold the token yet.
// GUARDIAN=<pubkey of a cold key or a multisig>: it alone can change the house wallets, empty the vault, change the settings and
// replace the authority. On mainnet it is required and must not be the wallet that signs here.
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { GoshiEscrow } from "../client/index.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));

const rpc = env("RPC_URL");
const conn = new Connection(rpc, "confirmed");
const wallet = load(env("WALLET"));
const programId = load(env("PROGRAM_KEYPAIR")).publicKey;
const mint = new PublicKey(env("MINT"));
const infra = new PublicKey(env("INFRA"));
const liquidity = new PublicKey(env("LIQUIDITY"));
const required = Number(env("REQUIRED_SABOTEURS", "3"));
const minHolder = BigInt(env("MIN_HOLDER", "100000000"));
const out = env("OUT");
const guardianText = process.env.GUARDIAN;
const guardian = guardianText ? new PublicKey(guardianText) : undefined;

const genesis = await conn.getGenesisHash();
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const isMainnet = genesis === MAINNET_GENESIS;
if (isMainnet && process.env.I_UNDERSTAND_THIS_IS_MAINNET !== "yes") throw new Error("this is MAINNET: set I_UNDERSTAND_THIS_IS_MAINNET=yes");
if (isMainnet && (!guardian || guardian.equals(wallet.publicKey))) throw new Error("on MAINNET a GUARDIAN different from this wallet is required (a cold key or a multisig)");

const g = new GoshiEscrow(programId);
if (await conn.getAccountInfo(g.pda.config)) throw new Error("already initialized");
const sig = await sendAndConfirmTransaction(
  conn,
  new Transaction().add(g.initialize(wallet.publicKey, infra, liquidity, mint, minHolder, required, guardian)),
  [wallet],
  { commitment: "confirmed" }
);
const cfg = {
  version: 5,
  native: true,
  requiredSaboteurs: required,
  cluster: isMainnet ? "mainnet-beta" : "devnet",
  programId: programId.toBase58(),
  authority: wallet.publicKey.toBase58(),
  guardian: (guardian ?? wallet.publicKey).toBase58(),
  goshiMint: mint.toBase58(),
  config: g.pda.config.toBase58(),
  vault: g.pda.vault.toBase58(),
  infraWallet: infra.toBase58(),
  liquidityWallet: liquidity.toBase58(),
  minHolder: minHolder.toString(),
  initializeTx: sig,
};
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
console.log(JSON.stringify(cfg, null, 2));
