// Test network only: a practice match won by a connected wallet pays real devnet SOL (it has no value, but it moves on chain), so the
// whole loop of winning and being paid can be felt without joining a room. Capped per wallet and per day, never on mainnet.
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { authority, connection } from "./chain.js";
import { config, log } from "./config.js";

const PRIZES = (process.env.PRACTICE_PRIZE_SOL ?? "0.02,0.01,0.005").split(",").map((s) => Math.round(Number(s) * LAMPORTS_PER_SOL)).filter((n) => n > 0);
const PER_WALLET_DAY = 6;
const GLOBAL_DAY = 150;
const MIN_GAP_MS = 60_000;
const FLOOR = 1 * LAMPORTS_PER_SOL; // never drain the platform wallet below this

const byWallet = new Map<string, number[]>();
let global: number[] = [];

export const practicePrizeOn = (): boolean => config.cluster === "devnet" && PRIZES.length > 0;

export async function payPracticePrize(wallet: string, place: number): Promise<{ lamports: string; tx: string } | null> {
  if (!practicePrizeOn() || place < 1 || place > PRIZES.length) return null;
  let to: PublicKey;
  try { to = new PublicKey(wallet); } catch { return null; }
  const now = Date.now();
  global = global.filter((t) => now - t < 86_400_000);
  const mine = (byWallet.get(wallet) ?? []).filter((t) => now - t < 86_400_000);
  if (global.length >= GLOBAL_DAY || mine.length >= PER_WALLET_DAY) return null;
  if (mine.length > 0 && now - mine[mine.length - 1] < MIN_GAP_MS) return null;
  const lamports = PRIZES[place - 1];
  try {
    if ((await connection.getBalance(authority.publicKey)) < lamports + FLOOR) return null;
    mine.push(now);
    byWallet.set(wallet, mine);
    global.push(now);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: to, lamports }));
    const sig = await connection.sendTransaction(tx, [authority]);
    await connection.confirmTransaction(sig, "confirmed");
    log("practice_prize", { wallet: wallet.slice(0, 6), place, lamports });
    return { lamports: String(lamports), tx: sig };
  } catch (e: any) {
    log("practice_prize_failed", { error: String(e?.message ?? e).slice(0, 100) });
    return null;
  }
}
