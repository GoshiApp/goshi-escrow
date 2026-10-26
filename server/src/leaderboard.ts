// The season ranking of the cash arenas: who won the most SOL, from the ledger of entries and payouts (the same lines that prove
// every transfer on chain). Net = what reached the wallet minus the entries paid. Bots are not ranked. Public data, read only.
import { config, log } from "./config.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

/** The current season: its name and its window (UTC). Season 0 runs on the test network, two weeks. */
export const SEASON = { id: "s0", from: Date.UTC(2026, 9, 26, 0, 0, 0), to: Date.UTC(2026, 10, 9, 23, 59, 59) };

export interface Row { wallet: string; net: number; won: number; paid: number; entries: number; cashouts: number; best: number }
let cache: { at: number; rows: Row[] } = { at: 0, rows: [] };

export async function leaderboard(): Promise<{ season: typeof SEASON; rows: Row[] }> {
  if (Date.now() - cache.at < 60_000) return { season: SEASON, rows: cache.rows };
  const rows = new Map<string, Row & { lastEntry: number }>();
  if (firestoreReady()) {
    try {
      const r = await fetch(`${firestoreBase()}:runQuery`, {
        method: "POST",
        headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: "cashledger" }],
          where: { fieldFilter: { field: { fieldPath: "at" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(SEASON.from) } } },
          orderBy: [{ field: { fieldPath: "at" }, direction: "ASCENDING" }], limit: 5000,
        } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        for (const x of (await r.json()) as any[]) {
          const f = x.document?.fields;
          if (!f || f.cluster?.stringValue !== config.cluster) continue;
          const at = Number(f.at?.integerValue ?? 0), kind = f.kind?.stringValue, w = f.wallet?.stringValue, l = Number(f.lamports?.integerValue ?? 0);
          if (at > SEASON.to || !w || (kind !== "entry" && kind !== "payout")) continue;
          const row = rows.get(w) ?? { wallet: w, net: 0, won: 0, paid: 0, entries: 0, cashouts: 0, best: 0, lastEntry: 0 };
          if (kind === "entry") { row.paid += l; row.entries++; row.lastEntry = l; }
          else { row.won += l; row.cashouts++; if (row.lastEntry) row.best = Math.max(row.best, l / row.lastEntry); }
          row.net = row.won - row.paid;
          rows.set(w, row);
        }
      }
    } catch (e: any) {
      log("leaderboard_failed", { error: String(e?.message ?? e).slice(0, 120) });
    }
  }
  const list = [...rows.values()].map(({ lastEntry: _l, ...r }) => r).sort((a, b) => b.net - a.net || b.won - a.won).slice(0, 50);
  cache = { at: Date.now(), rows: list };
  return { season: SEASON, rows: list };
}
