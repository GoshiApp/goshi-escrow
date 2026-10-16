// The permanent archive of finished matches: one small document per match (who played, the ranking, the closing
// transaction, the proof and every hash) and one document per replay file. Anybody can look their matches up by wallet,
// by room, by transaction or by hash. Everything in it is already public (it is on chain or derived from it).
// Firestore through its REST API with the service account of the server, like the counters. Without it, nothing is stored.
import { config, log } from "./config.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

export interface MatchRecord {
  roomId: string;
  at: number;
  mode: string;
  cluster: string;
  tx: string | null;
  entryFee: string;
  wallets: string[];
  hashes: string[];
  ranking: unknown;
  payout: unknown;
  proof: unknown;
}

const sv = (s: string) => ({ stringValue: s });
const MAX_BYTES = 700_000;

async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(`${firestoreBase()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  return r;
}

export async function archiveMatch(rec: MatchRecord, replays: Map<string, Uint8Array>): Promise<void> {
  if (!firestoreReady()) return;
  try {
    const fields = {
      roomId: sv(rec.roomId),
      at: { integerValue: String(rec.at) },
      mode: sv(rec.mode),
      cluster: sv(rec.cluster),
      tx: sv(rec.tx ?? ""),
      entryFee: sv(rec.entryFee),
      wallets: { arrayValue: { values: rec.wallets.map(sv) } },
      hashes: { arrayValue: { values: rec.hashes.map(sv) } },
      ranking: sv(JSON.stringify(rec.ranking)),
      payout: sv(JSON.stringify(rec.payout)),
      proof: sv(JSON.stringify(rec.proof ?? null)),
    };
    const r = await call(`/matches/${encodeURIComponent(rec.roomId)}`, { method: "PATCH", body: JSON.stringify({ fields }) });
    if (!r.ok) throw new Error(`match ${r.status} ${(await r.text()).slice(0, 80)}`);
    for (const [w, bytes] of replays) {
      if (bytes.length > MAX_BYTES) continue;
      const rr = await call(`/replays/${encodeURIComponent(`${rec.roomId}__${w}`)}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: { bytes: { bytesValue: Buffer.from(bytes).toString("base64") } } }),
      });
      if (!rr.ok) throw new Error(`replay ${rr.status}`);
    }
    log("match_archived", { roomId: rec.roomId, replays: replays.size });
  } catch (e: any) {
    log("archive_failed", { roomId: rec.roomId, error: String(e?.message ?? e).slice(0, 120) });
  }
}

function toRecord(d: any): MatchRecord | null {
  try {
    const f = d.fields ?? {};
    return {
      roomId: String(f.roomId?.stringValue ?? ""),
      at: Number(f.at?.integerValue ?? 0),
      mode: String(f.mode?.stringValue ?? ""),
      cluster: String(f.cluster?.stringValue ?? ""),
      tx: (f.tx?.stringValue ?? "") || null,
      entryFee: String(f.entryFee?.stringValue ?? "0"),
      wallets: (f.wallets?.arrayValue?.values ?? []).map((v: any) => String(v.stringValue)),
      hashes: (f.hashes?.arrayValue?.values ?? []).map((v: any) => String(v.stringValue)),
      ranking: JSON.parse(f.ranking?.stringValue ?? "[]"),
      payout: JSON.parse(f.payout?.stringValue ?? "null"),
      proof: JSON.parse(f.proof?.stringValue ?? "null"),
    };
  } catch {
    return null;
  }
}

async function query(field: string, value: string, limit = 100): Promise<MatchRecord[]> {
  if (!firestoreReady()) return [];
  const op = field === "wallets" || field === "hashes" ? "ARRAY_CONTAINS" : "EQUAL";
  const r = await call(":runQuery", {
    method: "POST",
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "matches" }], where: { fieldFilter: { field: { fieldPath: field }, op, value: { stringValue: value } } }, limit } }),
  });
  if (!r.ok) throw new Error(`query ${r.status}`);
  const rows = (await r.json()) as any[];
  // The archive holds the matches of every network; a server shows only its own.
  return rows.map((x) => (x.document ? toRecord(x.document) : null)).filter((x): x is MatchRecord => x !== null && x.cluster === config.cluster).sort((a, b) => b.at - a.at);
}

/**
 * The newest matches of everybody, newest first. `before` is the `at` of the last one already shown (the cursor), `mode` an
 * optional filter (done here, so no composite index is needed). Public data like the rest of the archive.
 */
export async function recentMatches(limit: number, before?: number, mode?: string): Promise<{ items: MatchRecord[]; next: number | null }> {
  if (!firestoreReady()) return { items: [], next: null };
  const want = Math.max(1, Math.min(30, Math.floor(limit)));
  // With a mode filter ask for more rows, then cut: a room of another mode is thrown away after the fact.
  const ask = Math.min(150, want * 5);
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: "matches" }],
    orderBy: [{ field: { fieldPath: "at" }, direction: "DESCENDING" }],
    limit: ask,
  };
  if (before !== undefined && Number.isFinite(before)) {
    structuredQuery.where = { fieldFilter: { field: { fieldPath: "at" }, op: "LESS_THAN", value: { integerValue: String(Math.floor(before)) } } };
  }
  const r = await call(":runQuery", { method: "POST", body: JSON.stringify({ structuredQuery }) });
  if (!r.ok) throw new Error(`recent ${r.status}`);
  const rows = (await r.json()) as any[];
  const scanned = rows.map((x) => (x.document ? toRecord(x.document) : null)).filter((x): x is MatchRecord => x !== null);
  // Only this network's matches (a mainnet page never shows a devnet match and the other way round), then the mode.
  const all = scanned.filter((m) => m.cluster === config.cluster);
  let items = mode ? all.filter((m) => m.mode === mode) : all;
  let next: number | null = null;
  if (items.length > want) {
    items = items.slice(0, want);
    next = items[want - 1].at;
  } else if (rows.length >= ask) {
    // The page was full of rows (most of them of another mode): there may be older ones, continue after the last one scanned.
    next = scanned[scanned.length - 1]?.at ?? null;
  }
  return { items, next };
}

export const matchesOfWallet = (w: string) => query("wallets", w);
export const matchByTx = (tx: string) => query("tx", tx, 5);
export const matchesByHash = (h: string) => query("hashes", h, 20);
export async function matchById(id: string): Promise<MatchRecord | null> {
  if (!firestoreReady()) return null;
  const r = await call(`/matches/${encodeURIComponent(id)}`);
  const rec = r.ok ? toRecord(await r.json()) : null;
  return rec && rec.cluster === config.cluster ? rec : null;
}
export async function storedReplay(roomId: string, wallet: string): Promise<Uint8Array | null> {
  if (!firestoreReady()) return null;
  try {
    const r = await call(`/replays/${encodeURIComponent(`${roomId}__${wallet}`)}`);
    if (!r.ok) return null;
    const b = (await r.json()).fields?.bytes?.bytesValue;
    return typeof b === "string" ? new Uint8Array(Buffer.from(b, "base64")) : null;
  } catch {
    return null;
  }
}
