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
if (config.devBots) loadAll();

export const isBot = (wallet: string) => bots.has(wallet);

function nextBot(exclude: Set<string>): Keypair {
  for (const [w, kp] of bots) if (!exclude.has(w)) return kp;
  fs.mkdirSync(dir, { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(path.join(dir, `bot-${bots.size + 1}.json`), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
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

  // Saboteurs first: a room turns active the moment the tenth paid seat is taken.
  for (let i = 0; i < wantFree; i++) {
    const bot = nextBot(inRoom);
    await topUpSol(bot.publicKey, 0.01 * LAMPORTS_PER_SOL, 0.02 * LAMPORTS_PER_SOL);
    if ((await goshiBalanceOf(bot.publicKey)) < config.minHolder) await mintTestTokens(bot.publicKey, config.minHolder * 2n);
    await joinFreeAs(bot, roomId);
    inRoom.add(bot.publicKey.toBase58());
    done.free++;
    log("bot_joined", { roomId, role: "saboteur", bot: bot.publicKey.toBase58() });
  }
  for (let i = 0; i < wantPaid; i++) {
    const bot = nextBot(inRoom);
    const need = Number(room.entryFee) + 0.02 * LAMPORTS_PER_SOL;
    await topUpSol(bot.publicKey, need, need + 0.02 * LAMPORTS_PER_SOL);
    await joinPaidAs(bot, roomId);
    inRoom.add(bot.publicKey.toBase58());
    done.paid++;
    log("bot_joined", { roomId, role: "paid", bot: bot.publicKey.toBase58() });
  }
  return done;
}

const lastFaucet = new Map<string, number>();
/** Devnet only: 1 SOL for fees and entries, and enough $GOSHI to take a saboteur seat. Once per 10 minutes. */
export async function faucet(wallet: string): Promise<{ sol: string; goshi: string; tx: string }> {
  if (!config.devBots || config.cluster !== "devnet") throw new Error("faucet_off");
  const now = Date.now();
  if (now - (lastFaucet.get(wallet) ?? 0) < 10 * 60 * 1000) throw new Error("faucet_rate_limited");
  const owner = new PublicKey(wallet);
  const solBalance = await connection.getBalance(owner);
  const heldGoshi = await goshiBalanceOf(owner);
  if (solBalance >= 3 * LAMPORTS_PER_SOL && heldGoshi >= config.minHolder) throw new Error("faucet_enough_tokens");
  lastFaucet.set(wallet, now);
  let sol = 0;
  if (solBalance < 3 * LAMPORTS_PER_SOL) {
    sol = LAMPORTS_PER_SOL;
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
