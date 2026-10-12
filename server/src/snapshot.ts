// The frozen photo of prices for one room. Prices are read off chain (CoinGecko, then Binance as a second source) and only
// the hash of the photo leaves the server, in the proof log of the closing transaction, so no oracle runs inside the program.
// Pyth Hermes now answers 401 without an API key, so it is not used until the operator has one.
import { log } from "./config.js";
import { FALLBACK_USD, SYMBOLS, makeSnapshot, type PriceSnapshot, type Sym } from "./game/frenzy.js";

let last: PriceSnapshot | null = null;
let lastTry = 0;

const CG_IDS: Record<Sym, string> = { SOL: "solana", DOGE: "dogecoin", AVAX: "avalanche-2", ETH: "ethereum", BNB: "binancecoin", BTC: "bitcoin" };

async function fromCoinGecko(): Promise<Record<Sym, number>> {
  const ids = SYMBOLS.map((s) => CG_IDS[s]).join(",");
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { signal: AbortSignal.timeout(4000) });
  const j: any = await r.json();
  const out: Partial<Record<Sym, number>> = {};
  for (const s of SYMBOLS) out[s] = Number(j?.[CG_IDS[s]]?.usd);
  return validate(out);
}

async function fromBinance(): Promise<Record<Sym, number>> {
  const pairs = JSON.stringify(SYMBOLS.map((s) => `${s}USDT`));
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(pairs)}`, { signal: AbortSignal.timeout(4000) });
  const j: any[] = await r.json();
  const out: Partial<Record<Sym, number>> = {};
  for (const s of SYMBOLS) out[s] = Number(j.find((x) => x?.symbol === `${s}USDT`)?.price);
  return validate(out);
}

function validate(o: Partial<Record<Sym, number>>): Record<Sym, number> {
  for (const s of SYMBOLS) {
    const v = o[s];
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e8)) throw new Error(`bad price for ${s}`);
  }
  return o as Record<Sym, number>;
}

/** The snapshot to freeze for a new room. Reuses a photo younger than 10 s; on failure keeps the last good one. */
export async function takeSnapshot(): Promise<PriceSnapshot> {
  const now = Date.now();
  if (last && last.source !== "fallback" && now - last.at < 10_000) return last;
  if (now - lastTry > 2000 || !last) {
    lastTry = now;
    for (const [source, fn] of [["coingecko", fromCoinGecko], ["binance", fromBinance]] as const) {
      try {
        last = makeSnapshot(await fn(), source, now);
        return last;
      } catch (e: any) {
        log("snapshot_failed", { source, error: String(e?.message ?? e).slice(0, 80) });
      }
    }
  }
  if (last && now - last.at < 10 * 60_000) return last;
  return makeSnapshot({ ...FALLBACK_USD }, "fallback", now);
}

/** The newest photo, for the ticker. */
export const latestSnapshot = () => last;
