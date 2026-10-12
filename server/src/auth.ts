import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "node:crypto";

export const newNonce = () => crypto.randomBytes(16).toString("hex");
export const authMessage = (nonce: string) => `goshi-play:${nonce}`;

export const SIWS_STATEMENT = "Sign in to Goshi. This is free and sends no transaction.";

/** The Sign In With Solana text. Wallets recognise this format and show a clean sign-in request instead of a warning. */
export function siwsMessage(o: { domain: string; address: string; uri: string; chain: string; nonce: string; issuedAt: string }): string {
  return `${o.domain} wants you to sign in with your Solana account:\n${o.address}\n\n${SIWS_STATEMENT}\n\nURI: ${o.uri}\nVersion: 1\nChain ID: ${o.chain}\nNonce: ${o.nonce}\nIssued At: ${o.issuedAt}`;
}

/** Checks the fields of a SIWS text against this connection: domain, address, nonce and a fresh time. */
export function siwsAccepted(message: string, wallet: string, nonce: string, allowedHosts: readonly string[], now = Date.now()): boolean {
  const m = /^([^\s]+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n([^\n]*)\n\nURI: ([^\n]+)\nVersion: 1\nChain ID: ([^\n]+)\nNonce: ([0-9a-f]+)\nIssued At: ([^\n]+)$/.exec(message);
  if (!m) return false;
  const [, domain, address, statement, uri, , n, issued] = m;
  if (address !== wallet || n !== nonce || statement !== SIWS_STATEMENT) return false;
  if (!allowedHosts.includes(domain)) return false;
  try {
    if (new URL(uri).host !== domain) return false;
  } catch {
    return false;
  }
  const t = Date.parse(issued);
  return Number.isFinite(t) && Math.abs(now - t) < 10 * 60_000;
}

/**
 * True when `signature` (base58) is the wallet's ed25519 signature over the sign-in text. With `message` it is the SIWS
 * text (checked field by field); without it, the older plain text `goshi-play:<nonce>`.
 */
export function verifyAuth(wallet: string, nonce: string, signature: string, message?: string, allowedHosts: readonly string[] = []): boolean {
  try {
    const pub = bs58.decode(wallet);
    const sig = bs58.decode(signature);
    if (pub.length !== 32 || sig.length !== 64) return false;
    if (message !== undefined) {
      if (message.length > 600 || !siwsAccepted(message, wallet, nonce, allowedHosts)) return false;
      return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
    }
    return nacl.sign.detached.verify(new TextEncoder().encode(authMessage(nonce)), sig, pub);
  } catch {
    return false;
  }
}

// ───────────── session tokens: sign in with the wallet once, reconnect without a popup ─────────────

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** `wallet.expiresAt.mac`, the mac is HMAC-SHA256 over "wallet.expiresAt" with a server secret. */
export function makeSession(wallet: string, secret: Buffer, now = Date.now(), ttlMs = SESSION_TTL_MS): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const body = `${wallet}.${expiresAt}`;
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return { token: `${body}.${mac}`, expiresAt };
}

/** The wallet a valid, unexpired token belongs to, or null. */
export function verifySession(token: unknown, secret: Buffer, now = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [wallet, exp, mac] = parts;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  const want = crypto.createHmac("sha256", secret).update(`${wallet}.${exp}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return wallet;
}

/** A stable secret derived from the authority key, so tokens survive restarts and new revisions. Never logged. */
export function sessionSecretFrom(authoritySecretKey: Uint8Array): Buffer {
  return crypto.createHash("sha256").update("goshi-session-v1").update(authoritySecretKey).digest();
}
