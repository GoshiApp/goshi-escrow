// The community board: anyone can propose a game, attach screenshots and vote it up or down. The most voted ideas are the
// ones that go first. No account, no wallet, no cookie: a browser keeps a random id in its own storage, and the server keeps
// only a short hash of it next to the vote. IP addresses are used in memory for rate limits and are never stored.
// Storage: Firestore (REST, same credentials as the counters). Without it the board lives in memory.
import crypto from "node:crypto";
import type http from "node:http";
import { PublicKey } from "@solana/web3.js";
import { config, log } from "./config.js";
import { isFounder } from "./game/skins.js";
import { goshiUsd } from "./tokenPrice.js";
import { makeSession, newNonce, sessionSecretFrom, verifyAuth, verifySession } from "./auth.js";
import { firestoreBase, firestoreReady, firestoreToken } from "./counters.js";

export const IDEA_STATUSES = ["open", "studying", "planned", "building", "live"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

interface Idea {
  id: string;
  title: string;
  text: string;
  at: number;
  status: IdeaStatus;
  votes: Record<string, 1 | -1>;
  reports: Record<string, 1>;
  hidden: boolean;
  images: string[];
}

const ideas = new Map<string, Idea>();
const dirty = new Set<string>();
let storeOn = false;
const COL = "ideas";

const LIMITS = {
  title: [4, 80], text: [20, 1500], images: 3, imageBytes: 280_000, body: 1_300_000, hideAfterReports: 3, maxIdeas: 2000,
  /** All the images of one idea together, as stored (a Firestore document is at most 1 MiB). */
  ideaImageChars: 800_000,
  /** All the images of every idea together: what the board may keep in memory. */
  boardImageChars: 40_000_000,
} as const;
const ADMIN = process.env.IDEAS_ADMIN ?? "";
/** Compares two secrets without leaking, through timing, how many leading characters matched. */
const sameSecret = (given: unknown, want: string): boolean => {
  if (want === "" || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ───────────── holder gate ─────────────
// With IDEAS_GATE=on, proposing, voting and reporting need a wallet that holds at least IDEAS_MIN_USD (20) worth of the token. The person
// signs in once (free, no transaction), the server checks the balance on chain and answers with a session token. Reading the
// board never needs a wallet.
const GATE = process.env.IDEAS_GATE === "on";
/** The minimum, in USD of $GOSHI held (not a token count): the price is read at the time of the check. */
const MIN_USD = Number(process.env.IDEAS_MIN_USD ?? "20");
// The chain module (and the authority key it loads) is only needed when the gate is on.
const chain = await import("./chain.js").catch(() => null);
// Without the authority key there is nothing to sign sessions with: they are refused, never signed with a known key.
const SESSION_SECRET = chain ? sessionSecretFrom(chain.authority.secretKey) : crypto.randomBytes(32);
const goshiMintText = chain ? chain.mint.toBase58() : "";
const nonces = new Map<string, number>();
const holdCache = new Map<string, { ok: boolean; ui: number; usd: number; at: number }>();

export async function holding(wallet: string): Promise<{ ok: boolean; ui: number; usd: number; price: number | null }> {
  const price = await goshiUsd();
  const c = holdCache.get(wallet);
  let ui: number;
  if (c && Date.now() - c.at < 5 * 60_000) ui = c.ui;
  else {
    ui = 0;
    try {
      const res = await chain!.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: chain!.mint });
      for (const a of res.value) ui += Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0);
    } catch (e: any) {
      log("ideas_holder_check_failed", { error: String(e?.message ?? e).slice(0, 80) });
      if (c) ui = c.ui;
      else throw e;
    }
    holdCache.set(wallet, { ok: false, ui, usd: 0, at: Date.now() });
  }
  const usd = price ? ui * price : 0;
  return { ok: price !== null && usd >= MIN_USD, ui, usd, price };
}

/** The voter key of a request: the wallet (hashed) when the gate is on, the browser id otherwise. null = not allowed. */
async function actor(b: any): Promise<{ key: string } | { error: string }> {
  if (!GATE) {
    const k = voterKey(b?.voter);
    return k ? { key: k } : { error: "voter" };
  }
  const wallet = verifySession(b?.session, SESSION_SECRET);
  if (!wallet) return { error: "session" };
  try {
    if (!(await holding(wallet)).ok) return { error: "not_holder" };
  } catch {
    return { error: "rpc" };
  }
  return { key: crypto.createHash("sha256").update("goshi-idea-wallet:" + wallet).digest("hex").slice(0, 20) };
}

// ───────────── persistence ─────────────

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ integerValue: String(n) });

function toFields(i: Idea) {
  return {
    title: sv(i.title), text: sv(i.text), at: iv(i.at), status: sv(i.status), hidden: { booleanValue: i.hidden },
    votes: sv(JSON.stringify(i.votes)), reports: sv(JSON.stringify(i.reports)), images: sv(JSON.stringify(i.images)),
  };
}

function fromDoc(d: any): Idea | null {
  try {
    const id = String(d.name).split("/").pop()!;
    const f = d.fields ?? {};
    const status = String(f.status?.stringValue ?? "open");
    return {
      id,
      title: String(f.title?.stringValue ?? ""),
      text: String(f.text?.stringValue ?? ""),
      at: Number(f.at?.integerValue ?? 0),
      status: (IDEA_STATUSES as readonly string[]).includes(status) ? (status as IdeaStatus) : "open",
      hidden: f.hidden?.booleanValue === true,
      votes: JSON.parse(f.votes?.stringValue ?? "{}"),
      reports: JSON.parse(f.reports?.stringValue ?? "{}"),
      images: JSON.parse(f.images?.stringValue ?? "[]"),
    };
  } catch {
    return null;
  }
}

export async function startIdeas(): Promise<void> {
  if (!firestoreReady()) return log("ideas_memory_only");
  try {
    let pageToken = "";
    do {
      const r = await fetch(`${firestoreBase()}/${COL}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
        headers: { authorization: `Bearer ${await firestoreToken()}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`firestore ${r.status}`);
      const j: any = await r.json();
      for (const d of j.documents ?? []) {
        const i = fromDoc(d);
        if (i) ideas.set(i.id, i);
      }
      pageToken = j.nextPageToken ?? "";
    } while (pageToken);
    storeOn = true;
    setInterval(() => void flushIdeas(), 5000).unref?.();
    log("ideas_ready", { count: ideas.size });
  } catch (e: any) {
    log("ideas_memory_only", { error: String(e?.message ?? e).slice(0, 80) });
  }
}

export async function flushIdeas(): Promise<void> {
  if (!storeOn || dirty.size === 0) return;
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) {
    try {
      const url = `${firestoreBase()}/${COL}/${id}`;
      const i = ideas.get(id);
      const r = i
        ? await fetch(url, { method: "PATCH", headers: { authorization: `Bearer ${await firestoreToken()}`, "content-type": "application/json" }, body: JSON.stringify({ fields: toFields(i) }), signal: AbortSignal.timeout(8000) })
        : await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${await firestoreToken()}` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok && r.status !== 404) throw new Error(`firestore ${r.status}`);
    } catch (e: any) {
      dirty.add(id);
      log("ideas_flush_failed", { error: String(e?.message ?? e).slice(0, 100) });
    }
  }
}

// ───────────── rules ─────────────

const clean = (s: unknown, max: number): string =>
  typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max) : "";

/** A short stable hash of the browser's random id: the only thing kept next to a vote. */
const voterKey = (id: unknown): string | null =>
  typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? crypto.createHash("sha256").update("goshi-idea-voter:" + id).digest("hex").slice(0, 20) : null;

function imageOk(dataUrl: unknown): string | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const b = Buffer.from(m[2], "base64");
  if (b.length < 32 || b.length > LIMITS.imageBytes) return null;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  const want = m[1] === "image/png" ? png : m[1] === "image/jpeg" ? jpg : webp;
  return want ? dataUrl : null;
}

const hits = new Map<string, number[]>();
/** True when this caller made `max` or more calls of `kind` in the last `windowMs`; records the call otherwise. */
/** The caller's address as Google's front end saw it: the LAST X-Forwarded-For entry (the first ones are written by the client). */
export function realIp(req: http.IncomingMessage): string {
  const parts = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts[parts.length - 1] || req.socket.remoteAddress || "?";
}

export function limited(ip: string, kind: string, max: number, windowMs: number): boolean {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.every((t) => now - t > 86_400_000)) hits.delete(k);
}, 600_000).unref?.();

const score = (i: Idea) => {
  let up = 0, down = 0;
  for (const v of Object.values(i.votes)) v === 1 ? up++ : down++;
  return { up, down, net: up - down };
};

function view(i: Idea, me: string | null) {
  const s = score(i);
  return { id: i.id, title: i.title, text: i.text, at: i.at, status: i.status, up: s.up, down: s.down, net: s.net, images: i.images.length, mine: me ? i.votes[me] ?? 0 : 0 };
}

export function listIdeas(q: { sort?: string; status?: string; limit?: number; me?: string | null }) {
  let rows = [...ideas.values()].filter((i) => !i.hidden);
  if (q.status && (IDEA_STATUSES as readonly string[]).includes(q.status)) rows = rows.filter((i) => i.status === q.status);
  const withScore = rows.map((i) => ({ i, s: score(i) }));
  if (q.sort === "new") withScore.sort((a, b) => b.i.at - a.i.at);
  else withScore.sort((a, b) => b.s.net - a.s.net || b.s.up - a.s.up || b.i.at - a.i.at);
  return withScore.slice(0, Math.min(Math.max(q.limit ?? 50, 1), 100)).map(({ i }) => view(i, q.me ?? null));
}

// ───────────── HTTP ─────────────

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let n = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > LIMITS.body) {
        resolve(null);
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

const clientIp = (req: http.IncomingMessage): string => {
  return realIp(req);
};

/** Handles /ideas routes. Returns false when the request is not for this module. */
export function handleIdeas(req: http.IncomingMessage, res: http.ServerResponse, allowedOrigins: readonly string[]): boolean {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://x"); } catch { return false; }
  if (url.pathname !== "/ideas" && !url.pathname.startsWith("/ideas/")) return false;
  const origin = String(req.headers.origin ?? "");
  const cors: Record<string, string> = allowedOrigins.includes(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-admin-token", "access-control-max-age": "600" }
    : {};
  const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end(), true;
  if (req.method !== "GET" && origin && !allowedOrigins.includes(origin)) return send(403, { error: "origin" }), true;
  const ip = clientIp(req);
  const parts = url.pathname.split("/").filter(Boolean); // ["ideas", id?, action?]
  const admin = sameSecret(req.headers["x-admin-token"], ADMIN);

  void (async () => {
    try {
      if (req.method === "GET" && parts.length === 2 && parts[1] === "gate") {
        const price = await goshiUsd();
        return send(200, { on: GATE, minUsd: MIN_USD, priceUsd: price, minTokens: price ? Math.ceil(MIN_USD / price) : null, mint: goshiMintText, chain: config.cluster === "mainnet-beta" ? "mainnet" : config.cluster });
      }
      if (req.method === "GET" && parts.length === 2 && parts[1] === "nonce") {
        if (limited(ip, "nonce", 20, 60_000)) return send(429, { error: "slow_down" });
        const n = newNonce();
        nonces.set(n, Date.now());
        for (const [k, t] of nonces) if (Date.now() - t > 5 * 60_000) nonces.delete(k);
        return send(200, { nonce: n, chain: config.cluster === "mainnet-beta" ? "mainnet" : config.cluster });
      }
      if (req.method === "POST" && parts.length === 2 && parts[1] === "session") {
        if (limited(ip, "session", 20, 60_000)) return send(429, { error: "slow_down" });
        const b = JSON.parse((await readBody(req)) ?? "{}");
        if (!chain) return send(503, { error: "chain" });
        const nonce = /Nonce: ([0-9a-f]+)/.exec(String(b.message ?? ""))?.[1] ?? "";
        const hosts = allowedOrigins.map((o) => { try { return new URL(o).host; } catch { return ""; } });
        if (!nonces.has(nonce) || !verifyAuth(String(b.wallet), nonce, String(b.signature), String(b.message), hosts)) return send(401, { error: "signature" });
        nonces.delete(nonce);
        let h: { ok: boolean; ui: number; usd: number; price: number | null };
        try { h = await holding(String(b.wallet)); } catch { return send(502, { error: "rpc" }); }
        const sess = makeSession(String(b.wallet), SESSION_SECRET);
        return send(200, { token: sess.token, expiresAt: sess.expiresAt, holder: !GATE || h.ok, balance: h.ui, balanceUsd: Math.round(h.usd * 100) / 100, minUsd: MIN_USD, priceUsd: h.price, founder: isFounder(String(b.wallet)) });
      }
      if (req.method === "GET" && parts.length === 1) {
        if (limited(ip, "read", 120, 60_000)) return send(429, { error: "slow_down" });
        let me = voterKey(url.searchParams.get("v"));
        if (GATE) {
          const w = verifySession(url.searchParams.get("s"), SESSION_SECRET);
          me = w ? crypto.createHash("sha256").update("goshi-idea-wallet:" + w).digest("hex").slice(0, 20) : null;
        }
        const items = listIdeas({ sort: url.searchParams.get("sort") ?? "top", status: url.searchParams.get("status") ?? "", limit: Number(url.searchParams.get("limit") ?? 50), me });
        return send(200, { items, total: [...ideas.values()].filter((i) => !i.hidden).length });
      }
      if (req.method === "GET" && parts.length === 3 && parts[2] === "images") {
        const i = ideas.get(parts[1]);
        if (!i || i.hidden) return send(404, { error: "not_found" });
        return send(200, { images: i.images }, { "cache-control": "public, max-age=300" });
      }
      if (req.method === "POST" && parts.length === 1) {
        if (limited(ip, "try", 20, 3_600_000)) return send(429, { error: "too_many" });
        if (ideas.size >= LIMITS.maxIdeas) return send(503, { error: "full" });
        const raw = await readBody(req);
        if (raw === null) return send(413, { error: "too_big" });
        let b: any;
        try { b = JSON.parse(raw); } catch { return send(400, { error: "bad_json" }); }
        const who = await actor(b);
        if ("error" in who) return send(who.error === "rpc" ? 502 : 403, { error: who.error });
        const voter = who.key;
        const title = clean(b.title, LIMITS.title[1]);
        const text = clean(b.text, LIMITS.text[1]);
        if (b.website) return send(200, { ok: true }); // honeypot: bots fill every field
        if (title.length < LIMITS.title[0] || text.length < LIMITS.text[0]) return send(400, { error: "short" });
        const imgs: string[] = [];
        let chars = 0;
        for (const d of Array.isArray(b.images) ? b.images.slice(0, LIMITS.images) : []) {
          const ok = imageOk(d);
          if (!ok) return send(400, { error: "image" });
          chars += ok.length;
          imgs.push(ok);
        }
        if (chars > LIMITS.ideaImageChars) return send(400, { error: "image" });
        let board = 0;
        for (const o of ideas.values()) for (const im of o.images) board += im.length;
        if (board + chars > LIMITS.boardImageChars) return send(503, { error: "full" });
        if (limited(ip, "create", 3, 3_600_000) || limited(ip, "create-day", 8, 86_400_000)) return send(429, { error: "too_many" });
        // The same text twice in a row is a double click or a bot, not a second idea.
        for (const o of ideas.values()) if (o.title.toLowerCase() === title.toLowerCase() && o.text === text) return send(200, { ok: true, id: o.id });
        const id = crypto.randomBytes(7).toString("base64url");
        const idea: Idea = { id, title, text, at: Date.now(), status: "open", votes: { [voter]: 1 }, reports: {}, hidden: false, images: imgs };
        ideas.set(id, idea);
        dirty.add(id);
        log("idea_created", { id, images: imgs.length });
        return send(200, { ok: true, id });
      }
      if (req.method === "POST" && parts.length === 3 && (parts[2] === "vote" || parts[2] === "report")) {
        if (limited(ip, "vote", 60, 60_000)) return send(429, { error: "slow_down" });
        const i = ideas.get(parts[1]);
        const raw = await readBody(req);
        let b: any = {};
        try { b = JSON.parse(raw ?? "{}"); } catch { /* handled below */ }
        const who = await actor(b);
        if (!i || i.hidden) return send(404, { error: "not_found" });
        if ("error" in who) return send(who.error === "rpc" ? 502 : 403, { error: who.error });
        const voter = who.key;
        if (parts[2] === "vote") {
          const v = Number(b.v);
          if (v === 0) delete i.votes[voter];
          else if (v === 1 || v === -1) i.votes[voter] = v;
          else return send(400, { error: "vote" });
        } else {
          i.reports[voter] = 1;
          if (Object.keys(i.reports).length >= LIMITS.hideAfterReports) i.hidden = true;
        }
        dirty.add(i.id);
        return send(200, { ok: true, idea: view(i, voter) });
      }
      if (admin && req.method === "DELETE" && parts.length === 2) {
        ideas.delete(parts[1]);
        dirty.add(parts[1]);
        return send(200, { ok: true });
      }
      if (admin && req.method === "POST" && parts.length === 3 && parts[2] === "status") {
        const i = ideas.get(parts[1]);
        const b = JSON.parse((await readBody(req)) ?? "{}");
        if (!i || !(IDEA_STATUSES as readonly string[]).includes(b.status)) return send(400, { error: "bad" });
        i.status = b.status;
        if (b.unhide === true) i.hidden = false;
        dirty.add(i.id);
        return send(200, { ok: true });
      }
      return send(404, { error: "not_found" });
    } catch (e: any) {
      log("ideas_error", { error: String(e?.message ?? e).slice(0, 100) });
      if (!res.headersSent) send(500, { error: "server" });
    }
  })();
  return true;
}
