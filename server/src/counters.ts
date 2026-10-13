// Totals that survive restarts and deploys: visits, matches and volume. Stored as three numbers in one Firestore document
// through its REST API with the credentials of the Cloud Run service account (no library, no extra secrets).
// Nothing about a person is stored: no address, no cookie, no identifier, only the counts.
import { log } from "./config.js";

const META = "http://metadata.google.internal/computeMetadata/v1";
const DOC = "counters/site";
const FLUSH_MS = 30_000;

export interface Totals { visits: number; matches: number; volume: bigint; wallets: number }

let projectId: string | null = null;
let token: { value: string; exp: number } | null = null;
let enabled = false;
const totals: Totals = { visits: 0, matches: 0, volume: 0n, wallets: 0 };
const pending = { visits: 0, matches: 0, volume: 0n, wallets: 0 };

async function meta(path: string): Promise<string> {
  const r = await fetch(`${META}/${path}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`metadata ${r.status}`);
  return r.text();
}

async function accessToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const j = JSON.parse(await meta("instance/service-accounts/default/token"));
  token = { value: String(j.access_token), exp: Date.now() + Number(j.expires_in) * 1000 };
  return token.value;
}

export const firestoreBase = () => base();
export const firestoreToken = (): Promise<string> => accessToken();
export const firestoreReady = (): boolean => enabled;

const base = () => `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

/** Loads the stored totals. Without the metadata server (local runs) the counters just live in memory. */
export async function startCounters(): Promise<void> {
  try {
    projectId = (await meta("project/project-id")).trim();
    const r = await fetch(`${base()}/${DOC}`, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(5000) });
    if (r.status === 200) {
      const f = (await r.json()).fields ?? {};
      totals.visits = Number(f.visits?.integerValue ?? 0);
      totals.matches = Number(f.matches?.integerValue ?? 0);
      totals.volume = BigInt(f.volume?.integerValue ?? 0);
      totals.wallets = Number(f.wallets?.integerValue ?? 0);
    } else if (r.status !== 404) {
      throw new Error(`firestore ${r.status}`);
    }
    enabled = true;
    setInterval(() => void flush(), FLUSH_MS).unref?.();
    log("counters_ready", { visits: totals.visits, matches: totals.matches });
  } catch (e: any) {
    log("counters_memory_only", { error: String(e?.message ?? e).slice(0, 80) });
  }
}

export const counts = (): Totals => ({ ...totals });

export function addVisit() {
  totals.visits++;
  pending.visits++;
}
export function addWallet() {
  totals.wallets++;
  pending.wallets++;
}
export function addMatch(volumeLamports: bigint) {
  totals.matches++;
  totals.volume += volumeLamports;
  pending.matches++;
  pending.volume += volumeLamports;
}

/** Adds the pending deltas with server side increments, so several instances never overwrite each other. */
export async function flush(): Promise<void> {
  if (!enabled || (pending.visits === 0 && pending.matches === 0 && pending.volume === 0n && pending.wallets === 0)) return;
  const d = { visits: pending.visits, matches: pending.matches, volume: pending.volume, wallets: pending.wallets };
  pending.wallets = 0;
  pending.visits = 0;
  pending.matches = 0;
  pending.volume = 0n;
  try {
    const name = `projects/${projectId}/databases/(default)/documents/${DOC}`;
    const body = {
      writes: [
        {
          transform: {
            document: name,
            fieldTransforms: [
              { fieldPath: "visits", increment: { integerValue: String(d.visits) } },
              { fieldPath: "matches", increment: { integerValue: String(d.matches) } },
              { fieldPath: "volume", increment: { integerValue: d.volume.toString() } },
              { fieldPath: "wallets", increment: { integerValue: String(d.wallets) } },
            ],
          },
        },
      ],
    };
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`commit ${r.status} ${(await r.text()).slice(0, 80)}`);
  } catch (e: any) {
    // Keep the numbers for the next flush.
    pending.wallets += d.wallets;
    pending.visits += d.visits;
    pending.matches += d.matches;
    pending.volume += d.volume;
    log("counters_flush_failed", { error: String(e?.message ?? e).slice(0, 100) });
  }
}
