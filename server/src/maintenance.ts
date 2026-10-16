// Scheduled maintenance without breaking anybody's match or money.
//
// A window has a start and an end. Before the start there is a guard period (longer than the longest match) in which nothing new
// begins: rooms and duels cannot be created, quick match is refused, and rooms still waiting are cancelled with every entry
// refunded. Matches already running finish normally, so by the start nothing is in flight and a deploy cannot cut a match.
//   none      no window
//   soon      a window is set, the guard has not begun: everything works, the site shows a countdown
//   draining  inside the guard: nothing new starts, running matches finish
//   down      inside the window: no matches, no new anything (practice too)
// The window is kept in Firestore so it survives restarts and every instance agrees. Set it with scripts/maintenance.sh.
import { log, netName } from "./config.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

export interface Window { startsAt: number; endsAt: number; message: string }
export type MaintState = "none" | "soon" | "draining" | "down";

/** Longest match (a duel: a minute of frenzy, a gap, ten minutes) plus time to settle on chain. */
export const GUARD_MS = Number(process.env.MAINT_GUARD_MS ?? 15 * 60_000);
const DOC = `config/${netName("maintenance")}`;
let current: Window | null = null;

export const maintenanceWindow = (): Window | null => current;

export function maintenanceState(now: number = Date.now()): MaintState {
  const w = current;
  if (!w || now >= w.endsAt) return "none";
  if (now >= w.startsAt) return "down";
  if (now >= w.startsAt - GUARD_MS) return "draining";
  return "soon";
}

/** What clients need: the instants and the state. Words are composed by the web in the visitor's language. */
export function maintenancePublic(now: number = Date.now()) {
  const w = current;
  if (!w || maintenanceState(now) === "none") return null;
  return { state: maintenanceState(now), startsAt: w.startsAt, blockFrom: w.startsAt - GUARD_MS, endsAt: w.endsAt, message: w.message };
}

/** Whether new money matches may begin (creating or filling rooms, duels, quick match). */
export const newMatchesAllowed = (now: number = Date.now()): boolean => {
  const s = maintenanceState(now);
  return s === "none" || s === "soon";
};

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${firestoreBase()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
}

export async function loadMaintenance(): Promise<void> {
  if (!firestoreReady()) return;
  try {
    const r = await api(`/${DOC}`);
    if (r.status === 404) { current = null; return; }
    if (!r.ok) return;
    const f = (await r.json()).fields ?? {};
    const startsAt = Number(f.startsAt?.integerValue ?? 0);
    const endsAt = Number(f.endsAt?.integerValue ?? 0);
    current = startsAt > 0 && endsAt > startsAt ? { startsAt, endsAt, message: String(f.message?.stringValue ?? "") } : null;
  } catch {
    // Keep the last known window: a failing read must not open the doors in the middle of a window.
  }
}

export async function setMaintenance(w: Window | null): Promise<boolean> {
  if (!firestoreReady()) { current = w; return true; }
  try {
    const r = w
      ? await api(`/${DOC}`, { method: "PATCH", body: JSON.stringify({ fields: { startsAt: { integerValue: String(w.startsAt) }, endsAt: { integerValue: String(w.endsAt) }, message: { stringValue: w.message } } }) })
      : await api(`/${DOC}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) return false;
    current = w;
    log("maintenance_set", w ? { startsAt: w.startsAt, endsAt: w.endsAt } : { cleared: true });
    return true;
  } catch {
    return false;
  }
}

export function startMaintenance(): void {
  void loadMaintenance();
  setInterval(() => void loadMaintenance(), 20_000).unref?.();
}
