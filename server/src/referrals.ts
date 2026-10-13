// Referrals: a wallet that arrives through a link `?ref=<wallet>` is remembered as referred by that wallet (first touch only,
// never itself). Each finished paid room credits the referrer 0.25% of what the referred wallet put in. That is one sixth of
// the infrastructure share of the rake, so it is paid by construction out of money the project already keeps, and a
// self-referral loses money (10% rake paid, 0.25% back). Credits are a public ledger; payouts are made by the team from the
// infrastructure wallet, not by the game server.
import { log } from "./config.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

export const REFERRAL_BPS = 25n; // 0.25% of the entry fee paid, in basis points of 10_000

const known = new Map<string, string | null>();
const sv = (s: string) => ({ stringValue: s });

async function call(path: string, init: RequestInit = {}) {
  return fetch(`${firestoreBase()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
}

export async function referrerOf(referee: string): Promise<string | null> {
  if (known.has(referee)) return known.get(referee) ?? null;
  if (!firestoreReady()) return null;
  try {
    const r = await call(`/referrals/${encodeURIComponent(referee)}`);
    if (r.status === 404) { known.set(referee, null); return null; }
    if (!r.ok) return null;
    const v = String((await r.json()).fields?.referrer?.stringValue ?? "") || null;
    known.set(referee, v);
    return v;
  } catch {
    return null;
  }
}

/** First touch wins: an existing referrer is never replaced. */
export async function setReferrer(referee: string, referrer: string): Promise<void> {
  if (!firestoreReady() || referee === referrer || (await referrerOf(referee)) !== null) return;
  try {
    const r = await call(`/referrals/${encodeURIComponent(referee)}?currentDocument.exists=false`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { referee: sv(referee), referrer: sv(referrer), at: { integerValue: String(Date.now()) } } }),
    });
    if (r.ok) { known.set(referee, referrer); log("referral_set", { referee: referee.slice(0, 6), referrer: referrer.slice(0, 6) }); }
  } catch { /* try again on the next sign in */ }
}

/** Credits the referrer of every referred paid wallet of a finished room. Idempotent per room and wallet. */
export async function accrueRoom(roomId: string, paidWallets: string[], cashLamports: bigint): Promise<void> {
  if (!firestoreReady() || paidWallets.length === 0) return;
  const each = (cashLamports * REFERRAL_BPS) / 10_000n / BigInt(paidWallets.length);
  if (each <= 0n) return;
  for (const w of paidWallets) {
    const ref = await referrerOf(w);
    if (!ref) continue;
    try {
      await call(`/refCredits/${encodeURIComponent(`${roomId}__${w}`)}?currentDocument.exists=false`, {
        method: "PATCH",
        body: JSON.stringify({ fields: { referrer: sv(ref), referee: sv(w), roomId: sv(roomId), lamports: { integerValue: each.toString() }, at: { integerValue: String(Date.now()) } } }),
      });
    } catch { /* the ledger entry is created once; a retry would be refused */ }
  }
}

async function runQuery(collection: string, field: string, value: string, limit = 1000): Promise<any[]> {
  const r = await call(":runQuery", {
    method: "POST",
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } }, limit } }),
  });
  if (!r.ok) throw new Error(`query ${r.status}`);
  return ((await r.json()) as any[]).filter((x) => x.document).map((x) => x.document);
}

/** Public numbers of a referrer: how many wallets it brought and how much it has accrued. */
export async function statsOf(referrer: string): Promise<{ referred: number; rooms: number; lamports: string }> {
  if (!firestoreReady()) return { referred: 0, rooms: 0, lamports: "0" };
  const [refs, credits] = await Promise.all([runQuery("referrals", "referrer", referrer), runQuery("refCredits", "referrer", referrer)]);
  let sum = 0n;
  for (const d of credits) sum += BigInt(d.fields?.lamports?.integerValue ?? 0);
  return { referred: refs.length, rooms: credits.length, lamports: sum.toString() };
}
