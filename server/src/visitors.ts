import { netName } from "./config.js";
// Who is counted as a visitor, without tracking anybody.
//  * Visitors: one per browser per UTC day. The page sends a random id kept in the browser; the server keeps only a salted hash of it
//    for the day, in memory, and adds one to a total the first time it sees it. Nothing is stored about the person. Browsers that
//    belong to the team send no id, so our own reloads never inflate the number.
//  * Wallets: how many different wallets connected to the game server, counted once each. A wallet address is public data.
import crypto from "node:crypto";
import { addVisit, addWallet } from "./counters.js";
import { isFounder } from "./game/skins.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

const SALT = crypto.randomBytes(16).toString("hex"); // changes at every start: yesterday's hashes cannot be linked to today's
let day = "";
let seen = new Set<string>();

export function isNewVisitorToday(vid: unknown, now: Date = new Date()): boolean {
  if (typeof vid !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(vid)) return false;
  const d = now.toISOString().slice(0, 10);
  if (d !== day) { day = d; seen = new Set(); }
  const h = crypto.createHash("sha256").update(`${SALT}:${d}:${vid}`).digest("hex").slice(0, 16);
  if (seen.has(h)) return false;
  seen.add(h);
  return true;
}

const known = new Set<string>();
/** Counts a wallet once, the first time it signs in. Test bots and the founder's wallet are not counted. */
export async function noteWallet(wallet: string, isBot: boolean): Promise<void> {
  if (isBot || isFounder(wallet) || known.has(wallet) || !firestoreReady()) return;
  known.add(wallet);
  try {
    const r = await fetch(`${firestoreBase()}/${netName("visitorWallets")}/${encodeURIComponent(wallet)}?currentDocument.exists=false`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { at: { integerValue: String(Date.now()) } } }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) addWallet(); // created now: first time ever
  } catch { /* counted on a later sign in */ }
}
