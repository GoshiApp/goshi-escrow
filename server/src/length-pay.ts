// Bought length in the live arena: the player pays SOL straight to the two house wallets (half maintenance, half project) and
// sends the signature here. The server checks the payment on chain before it gives anything: the transaction succeeded, it is
// recent, it moved at least the price into the two wallets, and it was never used before.
import { config } from "./config.js";
import { connection } from "./chain.js";
import { LENGTH_PRICE } from "./match.js";

const used = new Map<string, number>();
const MAX_AGE_S = 600;

/** "ok" with the wallet that paid (the fee payer of the transaction), or why the payment does not count. */
export async function checkLengthPayment(sig: string): Promise<{ r: "ok"; payer: string } | { r: "used" | "not_found" | "bad" }> {
  const res = await check(sig);
  return res;
}

async function check(sig: string): Promise<{ r: "ok"; payer: string } | { r: "used" | "not_found" | "bad" }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return { r: "bad" };
  if (used.has(sig)) return { r: "used" };
  used.set(sig, Date.now());
  for (const [k, t] of used) if (Date.now() - t > 2 * MAX_AGE_S * 1000) used.delete(k);
  try {
    let tx = null;
    for (let i = 0; i < 5 && !tx; i++) {
      tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!tx || !tx.meta || tx.meta.err) { used.delete(sig); return { r: "not_found" }; }
    if (!tx.blockTime || Date.now() / 1000 - tx.blockTime > MAX_AGE_S) return { r: "bad" };
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const gain = (w: string) => { const i = keys.indexOf(w); return i < 0 ? 0n : BigInt(tx!.meta!.postBalances[i] - tx!.meta!.preBalances[i]); };
    const half = LENGTH_PRICE / 2n;
    return gain(config.infraWallet) >= half && gain(config.liquidityWallet) >= LENGTH_PRICE - half ? { r: "ok", payer: keys[0] } : { r: "bad" };
  } catch {
    used.delete(sig);
    return { r: "not_found" };
  }
}
