// The secret behind a room's seed commitment must survive a restart of the server: without it the revealed seed would not match the
// commitment that was written on chain when the room was created. It is kept in Firestore (server only, no client rules) until the
// room is settled. A room whose secret is lost, or whose match was cut by a restart, is refunded and never replayed with a new secret.
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

async function call(path: string, init: RequestInit = {}) {
  return fetch(`${firestoreBase()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
}

export async function persistSecret(roomId: string, secret: Buffer): Promise<void> {
  if (!firestoreReady()) return;
  try {
    await call(`/roomSecrets/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { secret: { stringValue: secret.toString("hex") }, at: { integerValue: String(Date.now()) } } }),
    });
  } catch { /* the secret still lives in memory */ }
}

export async function loadSecret(roomId: string): Promise<{ secret: Buffer | null; started: boolean }> {
  if (!firestoreReady()) return { secret: null, started: false };
  try {
    const r = await call(`/roomSecrets/${encodeURIComponent(roomId)}`);
    if (!r.ok) return { secret: null, started: false };
    const f = (await r.json()).fields ?? {};
    const hex = String(f.secret?.stringValue ?? "");
    return { secret: /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null, started: f.startedAt?.integerValue !== undefined };
  } catch {
    return { secret: null, started: false };
  }
}

export async function markStarted(roomId: string): Promise<void> {
  if (!firestoreReady()) return;
  try {
    await call(`/roomSecrets/${encodeURIComponent(roomId)}?updateMask.fieldPaths=startedAt`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { startedAt: { integerValue: String(Date.now()) } } }),
    });
  } catch { /* best effort */ }
}

export async function dropSecret(roomId: string): Promise<void> {
  if (!firestoreReady()) return;
  try { await call(`/roomSecrets/${encodeURIComponent(roomId)}`, { method: "DELETE" }); } catch { /* best effort */ }
}
