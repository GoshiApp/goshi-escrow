import { ticketsOf } from "./cash-vault.js";
import { leaderboard } from "./leaderboard.js";
import { Arena, CASH_MIN_ENTRY } from "./game/arena.js";
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import http from "node:http";
import { WebSocketServer } from "ws";
import { authorityPubkey, syncHouseWallets } from "./chain.js";
import { config, log } from "./config.js";
import { Hub } from "./rooms.js";
import { startCounters, flush } from "./counters.js";
import { handleIdeas, startIdeas, flushIdeas, limited, realIp } from "./ideas.js";
import { statsOf } from "./referrals.js";
import { maintenancePublic, setMaintenance, startMaintenance } from "./maintenance.js";
import { clipById, recentClips } from "./var-clips.js";
import { matchById, matchByTx, matchesByHash, matchesOfWallet, recentMatches, storedReplay } from "./archive.js";
import { assertKeysSeparated } from "./keys.js";
import { handleRpc } from "./rpcProxy.js";
import { botWallets } from "./devbots.js";

// A rate limited RPC answer must never take the server down: log it and keep serving (rooms in memory would be lost).
process.on("uncaughtException", (e) => log("uncaught_exception", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
process.on("unhandledRejection", (e) => log("unhandled_rejection", { error: String((e as Error)?.message ?? e).slice(0, 200) }));

const hub = new Hub();

/** Answers of the public read endpoints, kept a few seconds: a script (or a crowd) asking the same thing costs one read. */
const readCache = new Map<string, { at: number; body: string }>();
async function cachedJson(key: string, ttlMs: number, compute: () => Promise<unknown>): Promise<string> {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const body = JSON.stringify(await compute());
  readCache.set(key, { at: Date.now(), body });
  if (readCache.size > 400) for (const [k, v] of readCache) if (Date.now() - v.at > ttlMs) readCache.delete(k);
  return body;
}

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const server = http.createServer((req, res) => {
  // How long the server keeps a message waiting (the event loop delay), so slowness is measured, not guessed.
  if (req.url === "/health/loop") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ p50: loopDelay.percentile(50) / 1e6, p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6, cpu: process.cpuUsage(), up: process.uptime() }));
    loopDelay.reset();
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true, region: process.env.REGION_NAME ?? null, chainRooms: config.rooms, cluster: config.cluster, programId: config.programId, devBots: config.devBots, rooms: hub.rooms.size, clients: hub.clients.size, matchesRunning: hub.matchesRunning(), maintenance: maintenancePublic(), revision: process.env.K_REVISION ?? null }));
    return;
  }
  const m = /^\/replay\/([0-9A-Za-z_-]{1,40})\/([0-9A-Za-z_]{1,64})$/.exec(req.url ?? "");
  if (m) {
    // A file that is in memory costs nothing; one that has to be read from the archive is limited per address.
    const mem = hub.replayOf(m[1], m[2]);
    if (!mem && limited(realIp(req), "replay", 90, 60_000)) return void res.writeHead(429, { "access-control-allow-origin": "*", "retry-after": "30" }).end();
    void (async () => {
      const b = mem ?? (await storedReplay(m[1], m[2]));
      if (!b) return void res.writeHead(404, { "access-control-allow-origin": "*" }).end();
      res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" });
      res.end(Buffer.from(b));
    })();
    return;
  }
  if ((req.url ?? "").split("?")[0] === "/admin/maintenance") {
    const token = process.env.ADMIN_TOKEN ?? process.env.IDEAS_ADMIN ?? "";
    const reply = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    const given = Buffer.from(String(req.headers["x-admin-token"] ?? ""));
    const want = Buffer.from(token);
    if (!token || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return void reply(403, { error: "forbidden" });
    if (req.method === "GET") return void reply(200, { maintenance: maintenancePublic() });
    if (req.method === "DELETE") return void setMaintenance(null).then((ok) => reply(ok ? 200 : 502, { ok }));
    if (req.method === "POST") {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => { if (parts.length < 20) parts.push(c); });
      req.on("end", () => {
        try {
          const b = JSON.parse(Buffer.concat(parts).toString("utf8"));
          const startsAt = Number(b.startsAt), endsAt = Number(b.endsAt);
          if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt || endsAt < Date.now()) return reply(400, { error: "bad_window" });
          void setMaintenance({ startsAt, endsAt, message: String(b.message ?? "").slice(0, 200) }).then((ok) => reply(ok ? 200 : 502, { ok, maintenance: maintenancePublic() }));
        } catch { reply(400, { error: "bad_json" }); }
      });
      return;
    }
    return void reply(405, { error: "method" });
  }
  if ((req.url ?? "").split("?")[0] === "/live") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({ duels: hub.liveDuels(), bots: [...botWallets(), ...[...hub.lives.values()].flatMap((l) => l.botAddresses())], ...(hub.live ? { arena: hub.live.stats(), arenas: [...hub.lives.values()].map((l) => l.summary()) } : {}) }));
    return;
  }
  // Cash arena tickets: the payments of a wallet to the vault that have not bought a place yet (devnet).
  const tk = /^\/cash\/tickets\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec((req.url ?? "").split("?")[0]);
  if (tk) {
    if (limited(realIp(req), "tickets", 30, 60_000)) return void res.writeHead(429, { "access-control-allow-origin": "*" }).end();
    void ticketsOf(tk[1], CASH_MIN_ENTRY).then(
      (list) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }); res.end(JSON.stringify({ tickets: list })); },
      () => { res.writeHead(502, { "access-control-allow-origin": "*" }).end(); },
    );
    return;
  }
  if ((req.url ?? "").split("?")[0] === "/duels") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({ ids: hub.duelIds() }));
    return;
  }
  const rf = /^\/referrals\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec((req.url ?? "").split("?")[0]);
  if (rf) {
    const ip = realIp(req);
    if (limited(ip, "archive", 60, 60_000)) return void res.writeHead(429, { "access-control-allow-origin": "*" }).end();
    void cachedJson(`ref:${rf[1]}`, 30_000, () => statsOf(rf[1])).then(
      (body) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }); res.end(body); },
      () => { res.writeHead(502, { "access-control-allow-origin": "*" }).end(); },
    );
    return;
  }
  // The season ranking of the cash arenas (who won the most SOL). Public data, read only, cached a minute.
  if ((req.url ?? "").split("?")[0] === "/leaderboard") {
    void leaderboard().then((j) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(JSON.stringify(j));
    });
    return;
  }
  // The VAR of the cash arena: every recorded clip, newest first, and any clip by its id. Public data, read only.
  if ((req.url ?? "").split("?")[0] === "/var/recent") {
    const qs = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    void recentClips(Number(qs.get("limit") ?? 30) || 30).then((items) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(JSON.stringify({ items }));
    });
    return;
  }
  const vm = /^\/var\/([0-9a-z-]{6,40})$/.exec((req.url ?? "").split("?")[0]);
  if (vm) {
    if (limited(realIp(req), "archive", 60, 60_000)) return void res.writeHead(429, { "access-control-allow-origin": "*" }).end();
    void clipById(vm[1]).then((c) => {
      res.writeHead(c ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": c ? "public, max-age=3600" : "no-store" });
      res.end(JSON.stringify(c ?? { error: "not_found" }));
    });
    return;
  }
  // The global history: the newest matches of everybody, newest first, with a cursor. Public data, read only.
  if ((req.url ?? "").split("?")[0] === "/matches/recent") {
    const ip = realIp(req);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": code === 200 ? "public, max-age=10" : "no-store" });
      res.end(JSON.stringify(body));
    };
    if (limited(ip, "archive", 60, 60_000)) return void send(429, { error: "slow_down" });
    const qs = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const limit = Number(qs.get("limit") ?? 20);
    const beforeRaw = qs.get("before");
    const before = beforeRaw !== null && /^\d{10,16}$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
    const modeRaw = qs.get("mode");
    const mode = modeRaw === "royale" || modeRaw === "vs" || modeRaw === "duel" ? modeRaw : undefined;
    const lim = Number.isFinite(limit) ? limit : 20;
    void cachedJson(`recent:${lim}:${before ?? ""}:${mode ?? ""}`, 10_000, () => recentMatches(lim, before, mode)).then(
      (body) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=10" }); res.end(body); },
      () => send(502, { error: "archive" }),
    );
    return;
  }
  // The match archive: look a match up by wallet, room, transaction or hash. Public data, read only.
  const q = /^\/matches\/(wallet|room|tx|hash)\/([0-9A-Za-z]{8,100})$/.exec((req.url ?? "").split("?")[0]);
  if (q) {
    const ip = realIp(req);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (limited(ip, "archive", 60, 60_000)) return void send(429, { error: "slow_down" });
    void (async () => {
      try {
        const key = `m:${q[1]}:${q[2]}`;
        const body = await cachedJson(key, 10_000, async () => {
          if (q[1] === "wallet") return { items: await matchesOfWallet(q[2]) };
          if (q[1] === "tx") return { items: await matchByTx(q[2]) };
          if (q[1] === "hash") return { items: await matchesByHash(q[2].toLowerCase()) };
          const one = await matchById(q[2]);
          return { items: one ? [one] : [] };
        });
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
        return void res.end(body);
      } catch {
        send(502, { error: "archive" });
      }
    })();
    return;
  }
  if (handleRpc(req, res)) return;
  if (handleIdeas(req, res, config.allowedOrigins)) return;
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  // Snapshots are repetitive JSON: deflate shrinks them a lot, which matters on mobile and long distance links.
  perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
  verifyClient: ({ origin }: { origin?: string }) => !origin || config.allowedOrigins.includes(origin),
});

const perIp = new Map<string, number>();
const MAX_SOCKETS_PER_IP = 40;
wss.on("connection", (ws, req) => {
  const ip = realIp(req);
  const open = (perIp.get(ip) ?? 0) + 1;
  if (open > MAX_SOCKETS_PER_IP) return void ws.close(1008, "too many connections");
  perIp.set(ip, open);
  ws.on("close", () => { const n = (perIp.get(ip) ?? 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); });
  const c = hub.connect(ws, ip);
  const idle = setInterval(() => {
    if (Date.now() - c.lastRefill > 60_000) ws.close();
  }, 15_000);
  ws.on("message", (data) => void hub.handle(c, data.toString()));
  ws.on("close", () => {
    clearInterval(idle);
    hub.disconnect(c);
  });
  ws.on("error", () => ws.close());
});

await assertKeysSeparated();
await syncHouseWallets();
setInterval(() => void syncHouseWallets(), 5 * 60_000);
await startCounters();
await startIdeas();
startMaintenance();
hub.start();
// No powers in any mode on any network: only the cash out stays.
Arena.onlyCashout = true;
if (process.env.LIVE_ARENA === "1" && config.cluster === "devnet") hub.enableLive();
if (config.guestRooms) hub.enableGuestRooms();
process.on("SIGTERM", () => void Promise.all([flush(), flushIdeas()]).finally(() => process.exit(0)));

// Only the newest revision may run matches. Cloud Run keeps an old instance alive while it holds sockets (up to an hour),
// and two hubs would start two matches for the same room. Every 20 s the instance asks its own public address which
// revision answers; when it is not this one, it steps down and exits, and the clients reconnect to the new one.
const SELF = process.env.SELF_URL;
const ME = process.env.K_REVISION;
if (SELF && ME) {
  setInterval(async () => {
    // With nobody connected there is nothing to protect, and asking would keep an on-demand server awake forever.
    if (hub.clients.size === 0 && hub.matchesRunning() === 0) return;
    try {
      const r = await fetch(`${SELF}/health`, { signal: AbortSignal.timeout(4000) });
      const j: any = await r.json();
      if (typeof j?.revision === "string" && j.revision !== ME) {
        log("stale_revision", { me: ME, current: j.revision });
        hub.stop();
        setTimeout(() => process.exit(0), 500);
      }
    } catch {
      // The check itself failing is not a reason to stop serving.
    }
  }, 20_000);
}

server.listen(config.port, () => {
  // Only public information is logged. The authority key never leaves the process.
  log("server_listening", {
    port: config.port,
    cluster: config.cluster,
    programId: config.programId,
    authority: authorityPubkey.toBase58(),
    devBots: config.devBots,
    matchMs: config.matchMs,
  });
});
