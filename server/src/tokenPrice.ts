// What one $GOSHI is worth in USD, to turn "hold at least 20 USD" into a balance check. DexScreener lists pump.fun and DEX pairs without
// a key; the pair with the most liquidity wins. If no price can be read the check FAILS CLOSED on mainnet (nobody passes) rather than
// letting a missing number open the gate. On devnet the token has no market: a fixed test price is used so the flow can be tried.
import { config, log } from "./config.js";

let cached: { usd: number; at: number } | null = null;
const TTL_MS = 60_000;
/** A pair thinner than this is not a price: a new token has little liquidity and anybody can open a pool with a made up price. */
const MIN_LIQUIDITY_USD = Number(process.env.GOSHI_MIN_LIQUIDITY_USD ?? "3000");
/** The price used is the LOWEST seen in this window, so a spike (a thin pool pushed up for a minute) never opens the gate. */
const WINDOW_MS = 15 * 60_000;
const seen: { usd: number; at: number }[] = [];

export async function goshiUsd(): Promise<number | null> {
  const manual = Number(process.env.GOSHI_USD ?? "");
  if (Number.isFinite(manual) && manual > 0) return manual;
  if (config.cluster !== "mainnet-beta") return 0.001; // devnet: a test price
  if (cached && Date.now() - cached.at < TTL_MS) return cached.usd;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${config.mint}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    const j: any = await r.json();
    const pairs: any[] = (j.pairs ?? []).filter((p: any) => p.chainId === "solana" && Number(p.priceUsd) > 0 && Number(p.liquidity?.usd ?? 0) >= MIN_LIQUIDITY_USD);
    pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
    const now = Number(pairs[0]?.priceUsd ?? 0);
    if (!(now > 0)) throw new Error("no pair with enough liquidity");
    seen.push({ usd: now, at: Date.now() });
    while (seen.length > 0 && Date.now() - seen[0].at > WINDOW_MS) seen.shift();
    const usd = Math.min(...seen.map((x) => x.usd));
    cached = { usd, at: Date.now() };
    return usd;
  } catch (e: any) {
    log("token_price_failed", { error: String(e?.message ?? e).slice(0, 80) });
    // A recent price is better than none for a few minutes; after that fail closed.
    return cached && Date.now() - cached.at < 10 * 60_000 ? cached.usd : null;
  }
}
