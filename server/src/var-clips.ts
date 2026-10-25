// The VAR of the cash arena: the last ten seconds before every elimination with money at stake and every cash out, kept by the
// server as it played them (not by any one screen), each with a SHA-256 fingerprint. Anybody can list them and watch any of them
// (GET /var/recent, GET /var/<id>). Stored in Firestore like the match archive; the newest are also kept in memory.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { config, log } from "./config.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

/** One picture: for every body [wallet, x, y, radius, mass, bag lamports, alive 1/0, body points flat x,y,...]. */
export type VarBody = [string, number, number, number, number, number, number, number[]];
/** One picture; `o` holds the coins on the map, flat [x, y, value, lamports, ...]. */
export interface VarFrame { t: number; b: VarBody[]; o?: number[] }
export interface VarClip {
  id: string;
  at: number;
  cluster: string;
  victim: string;
  by: string;
  kind: "eliminated" | "cashout";
  /** What the victim carried just before (lamports), and what it had entered with. */
  bag: number;
  entry: number;
  names: Record<string, string>;
  /** The skin each body wore, so the VAR shows them as they were. */
  skins?: Record<string, string>;
  frames: VarFrame[];
  hash: string;
  /** Where the body was when it died or cashed out (its head just before). */
  spot?: [number, number];
  /** Cash outs: the signature of the payout from the vault (added once it is confirmed; not part of the fingerprint). */
  paySig?: string;
}
export type VarSummary = Omit<VarClip, "frames" | "names" | "skins">;

/** The payout of a cash out is confirmed after its clip was saved: the newest cash out clip of that wallet gets the signature. */
const earlySigs = new Map<string, string>();
export function attachPaySig(victim: string, sig: string): void {
  const c = recent.find((x) => x.victim === victim && x.kind === "cashout" && !x.paySig);
  // The clip is saved two seconds after the cash out: a payout confirmed sooner waits for it.
  if (!c) { earlySigs.set(victim, sig); return; }
  c.paySig = sig;
  void persist(c);
}

const recent: VarClip[] = [];
// Clips carry three minutes of play: only the newest few are kept in memory, the rest are read back from Firestore.
const MAX_MEMORY = 8;

export function clipHash(c: Omit<VarClip, "hash">): string {
  return createHash("sha256").update(JSON.stringify({ ...c })).digest("hex");
}

export function saveClip(c: Omit<VarClip, "hash">): VarClip {
  const clip: VarClip = { ...c, hash: clipHash(c) };
  const early = clip.kind === "cashout" ? earlySigs.get(clip.victim) : undefined;
  if (early) { clip.paySig = early; earlySigs.delete(clip.victim); }
  recent.unshift(clip);
  if (recent.length > MAX_MEMORY) recent.length = MAX_MEMORY;
  log("var_clip", { id: clip.id, kind: clip.kind, victim: clip.victim, bag: clip.bag, hash: clip.hash });
  void persist(clip);
  return clip;
}

async function persist(clip: VarClip): Promise<void> {
  if (!firestoreReady()) return;
  try {
    // Three minutes of play: stored gzipped (base64), well under the size of a document.
    const z = gzipSync(JSON.stringify(clip)).toString("base64");
    if (z.length > 950_000) { log("var_clip_too_big", { id: clip.id, size: z.length }); return; }
    const r = await fetch(`${firestoreBase()}/varclips/${encodeURIComponent(clip.id)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: {
        at: { integerValue: String(clip.at) }, jsonz: { stringValue: z },
        // The summary, readable without the frames (the list of clips survives a restart of the server).
        summary: { stringValue: JSON.stringify(summary(clip)) }, cluster: { stringValue: clip.cluster },
      } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`varclip ${r.status}`);
  } catch (e: any) {
    log("var_persist_failed", { id: clip.id, error: String(e?.message ?? e).slice(0, 120) });
  }
}

const summary = (c: VarClip): VarSummary => ({ id: c.id, at: c.at, cluster: c.cluster, victim: c.victim, by: c.by, kind: c.kind, bag: c.bag, entry: c.entry, hash: c.hash, ...(c.paySig ? { paySig: c.paySig } : {}) });

/** The newest clips, newest first: from Firestore (so they survive a restart), merged with those still in memory. */
export async function recentClips(limit: number): Promise<VarSummary[]> {
  const lim = Math.max(1, Math.min(60, limit));
  const out = new Map<string, VarSummary>(recent.map((c) => [c.id, summary(c)]));
  if (firestoreReady()) {
    try {
      const r = await fetch(`${firestoreBase()}:runQuery`, {
        method: "POST",
        headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "varclips" }], select: { fields: [{ fieldPath: "summary" }, { fieldPath: "cluster" }] }, orderBy: [{ field: { fieldPath: "at" }, direction: "DESCENDING" }], limit: lim * 2 } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        for (const row of (await r.json()) as any[]) {
          const f = row.document?.fields;
          if (!f?.summary?.stringValue || f.cluster?.stringValue !== config.cluster) continue;
          const sm = JSON.parse(f.summary.stringValue) as VarSummary;
          if (!out.has(sm.id)) out.set(sm.id, sm);
        }
      }
    } catch (e: any) {
      log("var_list_failed", { error: String(e?.message ?? e).slice(0, 120) });
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at).slice(0, lim);
}

export async function clipById(id: string): Promise<VarClip | null> {
  const mem = recent.find((c) => c.id === id);
  if (mem) return mem;
  if (!firestoreReady()) return null;
  try {
    const r = await fetch(`${firestoreBase()}/varclips/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${await firestoreToken()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    if (d.fields?.jsonz?.stringValue) return JSON.parse(gunzipSync(Buffer.from(d.fields.jsonz.stringValue, "base64")).toString());
    return JSON.parse(d.fields?.json?.stringValue ?? "null");
  } catch {
    return null;
  }
}

void config;
