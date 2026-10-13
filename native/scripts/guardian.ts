// The guardian's toolbox: everything only the cold key can do. Read it, then run it on the machine that holds the key.
//
//   RPC_URL=https://api.devnet.solana.com PROGRAM_ID=<program id> GUARDIAN_KEYPAIR=../.devnet-guardian.json \
//     npx tsx scripts/guardian.ts <command> [arguments]
//
// show                                   who is who on chain, the house wallets, what the vault holds
// withdraw <destination> <sol|all>       send what the vault holds (burn + super pot) to a wallet
// set-wallets <infra> <liquidity>        the wallets that receive the infrastructure and liquidity shares
// set-authority <new authority keypair>  replace the game key (the new key signs too); use it when the hot key is lost or stolen
// set-guardian <new guardian keypair>    hand the guardian role to another key (the new key signs too)
// min-holder <tokens>                    $GOSHI needed for a saboteur seat (whole tokens)
// saboteurs <0..3>                       saboteurs a room needs before it starts
//
// Without GUARDIAN_KEYPAIR but with GUARDIAN_PUBKEY=<address> the transaction is only built and printed (base64, unsigned, fee payer
// = the guardian): sign it with the hardware wallet or import it in a multisig app. Nothing is sent.
import fs from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { GoshiEscrow, decodeConfig, decodeVault } from "../client/index.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
};
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const conn = new Connection(env("RPC_URL", "https://api.devnet.solana.com"), "confirmed");
const programId = new PublicKey(env("PROGRAM_ID", "11111111111111111111111111111111"));
const g = new GoshiEscrow(programId);
const [cmd, ...args] = process.argv.slice(2);
const usage = () => console.log(fs.readFileSync(new URL(import.meta.url).pathname, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
if (!cmd || cmd === "help") {
  usage();
  process.exit(0);
}
const keyFile = process.env.GUARDIAN_KEYPAIR;
const signer = keyFile ? load(keyFile) : null;
const guardian = signer ? signer.publicKey : new PublicKey(env("GUARDIAN_PUBKEY", "11111111111111111111111111111111"));
const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);

async function roles() {
  const a = await conn.getAccountInfo(g.pda.config);
  const c = a ? decodeConfig(a.data) : null;
  if (!c) throw new Error("the program is not initialized, or its configuration is the old layout (run scripts/migrate.ts)");
  return c;
}

async function send(ixs: ReturnType<GoshiEscrow["setWallets"]>[], extra: Keypair[] = []) {
  const c = await roles();
  if (!c.guardian.equals(guardian)) throw new Error(`this key is not the guardian (the guardian is ${c.guardian.toBase58()})`);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = guardian;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  if (!signer) {
    console.log("Unsigned transaction (base64). Sign it with the guardian and send it:\n");
    console.log(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
    return;
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [signer, ...extra], { commitment: "confirmed" });
  console.log("done:", sig);
}

if (cmd === "show") {
  const c = await roles();
  const v = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
  const prog = await conn.getAccountInfo(programId);
  let upgrade = "unknown";
  if (prog && prog.data.length >= 36) {
    const pd = await conn.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
    if (pd && pd.data.length >= 45) upgrade = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : "immutable (nobody can upgrade it)";
  }
  console.log(JSON.stringify({
    program: programId.toBase58(),
    gameAuthority: c.authority.toBase58(),
    guardian: c.guardian.toBase58(),
    upgradeAuthority: upgrade,
    infraWallet: c.infraWallet.toBase58(),
    liquidityWallet: c.liquidityWallet.toBase58(),
    minHolderBaseUnits: c.minHolder.toString(),
    requiredSaboteurs: c.requiredSaboteurs,
    vault: { burnSol: sol(v.openBurn), superPotSol: sol(v.openJackpot), withdrawableSol: sol(v.openBurn + v.openJackpot) },
    thisKeyIsTheGuardian: c.guardian.equals(guardian),
  }, null, 2));
} else if (cmd === "withdraw") {
  const dest = new PublicKey(args[0] ?? "");
  const v = decodeVault((await conn.getAccountInfo(g.pda.vault))!.data)!;
  const pending = v.openBurn + v.openJackpot;
  const amount = args[1] === "all" ? pending : BigInt(Math.round(Number(args[1]) * LAMPORTS_PER_SOL));
  if (!(amount > 0n) || amount > pending) throw new Error(`the vault holds ${sol(pending)} SOL that can be withdrawn`);
  console.log(`sending ${sol(amount)} SOL from the vault to ${dest.toBase58()}`);
  await send([g.withdrawVault(guardian, dest, amount)]);
} else if (cmd === "set-wallets") {
  await send([g.setWallets(guardian, new PublicKey(args[0] ?? ""), new PublicKey(args[1] ?? ""))]);
} else if (cmd === "set-authority") {
  const next = load(args[0] ?? "");
  console.log(`the new game authority will be ${next.publicKey.toBase58()}`);
  await send([g.setAuthority(guardian, next.publicKey)], [next]);
} else if (cmd === "set-guardian") {
  const next = load(args[0] ?? "");
  console.log(`the new guardian will be ${next.publicKey.toBase58()}`);
  await send([g.setGuardian(guardian, next.publicKey)], [next]);
} else if (cmd === "min-holder") {
  await send([g.setMinHolder(guardian, BigInt(Math.round(Number(args[0]) * 1_000_000)))]);
} else if (cmd === "saboteurs") {
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < 0 || n > 3) throw new Error("0 to 3");
  await send([g.setRequiredSaboteurs(guardian, n)]);
} else {
  usage();
}
