// A small JSON-RPC relay for the website: the public Solana RPC refuses browsers (403) and a paid key must not be shipped to them.
// The page talks to this endpoint, the server holds the real RPC url. Only the reads and the send a game page needs are allowed.
import type http from "node:http";
import { config, log } from "./config.js";
import { limited, realIp } from "./ideas.js";

const METHODS = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getLatestBlockhash", "getBlockHeight", "getSlot",
  "getSignatureStatuses", "getTransaction", "getTokenAccountBalance", "getTokenAccountsByOwner", "getMinimumBalanceForRentExemption",
  "simulateTransaction", "sendTransaction", "isBlockhashValid", "getFeeForMessage", "getRecentPrioritizationFees", "getBlockTime",
  "getSignaturesForAddress", "getGenesisHash", "getVersion",
]);
// Reads that many visitors repeat: kept for a moment so a crowd costs one call.
const CACHEABLE = new Set(["getProgramAccounts", "getAccountInfo", "getLatestBlockhash", "getBalance", "getMultipleAccounts", "getSlot", "getTokenAccountBalance"]);
const CACHE_MS = 1500;
const cache = new Map<string, { at: number; status: number; body: string }>();
const MAX_BODY = 64 * 1024;

export function handleRpc(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if ((req.url ?? "").split("?")[0] !== "/rpc") return false;
  const origin = req.headers.origin;
  // web3.js adds its own client header: answer with whatever the browser says it will send.
  const reqHeaders = String(req.headers["access-control-request-headers"] ?? "content-type").slice(0, 200);
  const allowed = typeof origin === "string" && config.allowedOrigins.includes(origin);
  const cors: Record<string, string> = allowed
    ? { "access-control-allow-origin": origin as string, vary: "Origin", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": reqHeaders, "access-control-max-age": "86400" }
    : {};
  if (req.method === "OPTIONS") { res.writeHead(allowed ? 204 : 403, cors).end(); return true; }
  const fail = (code: number, msg: string) => void res.writeHead(code, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: msg }, id: null }));
  if (req.method !== "POST") { fail(405, "method"); return true; }
  if (!allowed) { fail(403, "origin"); return true; }
  // Per address, and a budget for the whole server: a crowd of addresses cannot burn the paid RPC either.
  if (limited(realIp(req), "rpc", 120, 60_000) || limited("all", "rpc-global", 4000, 60_000)) { res.writeHead(429, { ...cors, "retry-after": "10" }).end(); return true; }

  const chunks: Buffer[] = [];
  let size = 0;
  let dead = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) { dead = true; fail(413, "too large"); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (dead) return;
    void (async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(400, "json"); }
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (calls.length === 0 || calls.length > 10) return fail(400, "batch");
      for (const c of calls as { method?: unknown; params?: unknown[] }[]) {
        if (!c || typeof c.method !== "string" || !METHODS.has(c.method)) return fail(403, "method not allowed");
        // The program accounts of anybody else's program are not this server's business.
        if (c.method === "getProgramAccounts" && (!Array.isArray(c.params) || c.params[0] !== config.programId)) return fail(403, "program not allowed");
      }
      const key = calls.every((c: { method: string }) => CACHEABLE.has(c.method)) ? JSON.stringify(calls.map((c: { id?: unknown }) => ({ ...c, id: 0 }))) : null;
      if (key) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_MS) {
          // The answer carries the id of whoever asked first: put this caller's ids back.
          let body = hit.body;
          try {
            const j = JSON.parse(body);
            if (Array.isArray(j)) j.forEach((x, i) => { x.id = (calls[i] as { id?: unknown }).id ?? null; });
            else j.id = (calls[0] as { id?: unknown }).id ?? null;
            body = JSON.stringify(j);
          } catch { /* serve it as it is */ }
          res.writeHead(hit.status, { ...cors, "content-type": "application/json" }).end(body);
          return;
        }
      }
      try {
        const up = await fetch(config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed), signal: AbortSignal.timeout(15_000) });
        const body = await up.text();
        if (key && up.ok) {
          cache.set(key, { at: Date.now(), status: up.status, body });
          if (cache.size > 300) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
        }
        res.writeHead(up.status, { ...cors, "content-type": "application/json" }).end(body);
      } catch (e) {
        log("rpc_proxy_failed", { error: String((e as Error)?.message ?? e).slice(0, 120) });
        fail(502, "upstream");
      }
    })();
  });
  return true;
}
