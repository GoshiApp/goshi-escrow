import { config, log } from "./config.js";

const LAMPORTS = 1_000_000_000;
export interface FeeOption {
  lamports: bigint;
  usd: number;
}

let solUsd = Number(process.env.SOL_USD ?? process.env.SOL_USD_FALLBACK ?? 150);
let fetchedAt = 0;
let current: FeeOption[] = build(solUsd);
let previous: FeeOption[] = [];

/** Entry options near the wanted dollar amounts, rounded to 0.001 SOL so they are tidy numbers. */
export function build(price: number): FeeOption[] {
  return config.feeUsd.map((usd) => {
    const sol = Math.max(0.001, Math.round((usd / price) * 1000) / 1000);
    return { lamports: BigInt(Math.round(sol * LAMPORTS)), usd };
  });
}

async function binanceSol(): Promise<number | null> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { signal: AbortSignal.timeout(4000) });
    const p = Number(((await r.json()) as any)?.price);
    return Number.isFinite(p) && p > 1 && p < 100000 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Refreshes the SOL price at most every 5 minutes. A move of more than 30 percent in one step is only accepted when a second
 * source agrees within 3 percent: one wrong answer must not reprice every room. Without an answer the last price is kept.
 */
export async function refreshPrice(force = false): Promise<void> {
  if (process.env.SOL_USD) return; // fixed by the operator
  if (!force && Date.now() - fetchedAt < 5 * 60_000) return;
  fetchedAt = Date.now();
  try {
    let p = NaN;
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(4000) });
      p = Number(((await r.json()) as any)?.solana?.usd);
    } catch { /* the second source below */ }
    if (!(Number.isFinite(p) && p > 1 && p < 100000)) {
      const b = await binanceSol();
      if (b === null) throw new Error("no price from any source");
      p = b;
    }
    if (Math.abs(p - solUsd) / solUsd > 0.3) {
      const b = await binanceSol();
      if (b === null || Math.abs(b - p) / p > 0.03) {
        log("sol_price_rejected", { usd: p });
        return;
      }
    }
    if (Math.abs(p - solUsd) / solUsd > 0.02) {
      previous = current;
      solUsd = p;
      current = build(solUsd);
      log("sol_price", { usd: p });
    }
  } catch (e: any) {
    log("sol_price_failed", { error: String(e?.message ?? e).slice(0, 80) });
  }
}

export const feeOptions = (): FeeOption[] => current;
export const solPriceUsd = () => solUsd;

/** A requested fee is accepted when it is one of the current options or of the previous ones (price just moved). */
export function feeAllowed(fee: bigint): boolean {
  return [...current, ...previous].some((o) => o.lamports === fee);
}

/** The dollar tier (1, 2.5, 5...) of an entry fee, from the current or the previous options, or null. */
export function tierUsdOf(fee: bigint): number | null {
  const o = [...current, ...previous].find((x) => x.lamports === fee);
  return o ? o.usd : null;
}

/** The entry fee of a dollar tier at the current price. */
export function feeOfTier(usd: number): bigint | null {
  return current.find((o) => o.usd === usd)?.lamports ?? null;
}
