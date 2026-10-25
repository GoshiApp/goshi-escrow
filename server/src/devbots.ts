import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config, log } from "./config.js";
import { authority, connection, ensureTokenAccount, fetchRoom, goshiBalanceOf, joinFreeAs, joinPaidAs, mintTestTokens } from "./chain.js";

// Devnet test helpers only. The bots are the server's own wallets, funded from the authority wallet.
const dir = path.join(config.serverDir, ".devbots");
const bots = new Map<string, Keypair>();

function loadAll() {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
    bots.set(kp.publicKey.toBase58(), kp);
  }
}
/** Bots are derived from the server key, so every instance and every restart knows the same bots (a container's disk is not kept). */
function derivedBot(i: number): Keypair {
  const seed = crypto.createHash("sha256").update("goshi-devbot-v1").update(authority.secretKey).update(String(i)).digest();
  return Keypair.fromSeed(Uint8Array.from(seed));
}
if (config.devBots) {
  loadAll();
  for (let i = 0; i < 64; i++) {
    const kp = derivedBot(i);
    bots.set(kp.publicKey.toBase58(), kp);
  }
}

export const isBot = (wallet: string) => bots.has(wallet);
/** The addresses of the test bots (devnet only; empty elsewhere), so the page can say how many seats of a room are bots. */
export const botWallets = (): string[] => (config.devBots ? [...bots.keys()] : []);

function nextBot(exclude: Set<string>): Keypair {
  for (const [w, kp] of bots) if (!exclude.has(w)) return kp;
  // More bots than the derived ones are needed only in the largest rooms: make one more, also derived.
  const kp = derivedBot(bots.size + 1000);
  bots.set(kp.publicKey.toBase58(), kp);
  return kp;
}

async function topUpSol(to: PublicKey, minLamports: number, sendLamports: number) {
  if ((await connection.getBalance(to)) >= minLamports) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: to, lamports: sendLamports }));
  await connection.sendTransaction(tx, [authority]).then((sig) => connection.confirmTransaction(sig, "confirmed"));
}

/** Makes test bots join on-chain: `paid` paid seats and `free` saboteur seats. Returns how many joined. */
export async function fillWithBots(roomId: string, paid: number, free: number): Promise<{ paid: number; free: number }> {
  if (!config.devBots || config.cluster !== "devnet") throw new Error("dev bots are off");
  const room = await fetchRoom(roomId);
  if (!room || room.state !== "waiting") throw new Error("room is not waiting");
  const inRoom = new Set([...room.paid, ...room.free]);
  const wantFree = Math.min(free, config.freeSlots - room.free.length);
  const wantPaid = Math.min(paid, config.paidSlots - room.paid.length);
  const done = { paid: 0, free: 0 };

  // Saboteurs first: a room turns active the moment the tenth paid seat is taken. Every bot is picked first (no two the same),
  // then each group joins in parallel: funding and joining one by one took close to a minute for a full room.
  const sabs = Array.from({ length: wantFree }, () => { const bot = nextBot(inRoom); inRoom.add(bot.publicKey.toBase58()); return bot; });
  const paids = Array.from({ length: wantPaid }, () => { const bot = nextBot(inRoom); inRoom.add(bot.publicKey.toBase58()); return bot; });
  const need = Number(room.entryFee) + 0.02 * LAMPORTS_PER_SOL;
  await Promise.all([
    ...sabs.map(async (bot) => {
      await topUpSol(bot.publicKey, 0.01 * LAMPORTS_PER_SOL, 0.02 * LAMPORTS_PER_SOL);
      if ((await goshiBalanceOf(bot.publicKey)) < config.minHolder) await mintTestTokens(bot.publicKey, config.minHolder * 2n);
    }),
    ...paids.map((bot) => topUpSol(bot.publicKey, need, need + 0.02 * LAMPORTS_PER_SOL)),
  ]);
  const join = async (bot: Keypair, role: "saboteur" | "paid") => {
    try {
      if (role === "saboteur") await joinFreeAs(bot, roomId); else await joinPaidAs(bot, roomId);
      if (role === "saboteur") done.free++; else done.paid++;
      log("bot_joined", { roomId, role, bot: bot.publicKey.toBase58() });
    } catch (e: any) {
      log("bot_join_failed", { roomId, role, error: String(e?.message ?? e).slice(0, 120) });
    }
  };
  await Promise.all(sabs.map((b) => join(b, "saboteur")));
  await Promise.all(paids.map((b) => join(b, "paid")));
  return done;
}

const lastFaucet = new Map<string, number>();
/** A wallet below this balance gets the SOL part of the faucet; the faucet gives this much. */
const FAUCET_LOW = 0.15 * LAMPORTS_PER_SOL;
const FAUCET_SOL = 0.25 * LAMPORTS_PER_SOL;
/** Devnet only: 1 SOL for fees and entries, and enough $GOSHI to take a saboteur seat. Once per 10 minutes. */
export async function faucet(wallet: string): Promise<{ sol: string; goshi: string; tx: string }> {
  if (!config.devBots || config.cluster !== "devnet") throw new Error("faucet_off");
  const now = Date.now();
  if (now - (lastFaucet.get(wallet) ?? 0) < 10 * 60 * 1000) throw new Error("faucet_rate_limited");
  const owner = new PublicKey(wallet);
  const solBalance = await connection.getBalance(owner);
  const heldGoshi = await goshiBalanceOf(owner);
  if (solBalance >= FAUCET_LOW && heldGoshi >= config.minHolder) throw new Error("faucet_enough_tokens");
  lastFaucet.set(wallet, now);
  let sol = 0;
  if (solBalance < FAUCET_LOW) {
    // Enough for many rooms (entries are a few hundredths of a SOL) and keeps the platform wallet from draining.
    sol = FAUCET_SOL;
    const platform = await connection.getBalance(authority.publicKey);
    if (platform < FAUCET_SOL + 50_000_000) throw new Error("faucet_empty");
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: owner, lamports: sol }));
    await connection.sendTransaction(tx, [authority]).then((sig) => connection.confirmTransaction(sig, "confirmed"));
  }
  let goshi = 0n;
  let tx = "";
  if (heldGoshi < config.minHolder) {
    goshi = config.minHolder * 2n;
    tx = await mintTestTokens(owner, goshi);
  }
  return { sol: String(sol), goshi: goshi.toString(), tx };
}
