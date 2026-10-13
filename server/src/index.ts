import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";
import { authorityPubkey } from "./chain.js";
import { config, log } from "./config.js";
import { Hub } from "./rooms.js";
import { startCounters, flush } from "./counters.js";
import { handleIdeas, startIdeas, flushIdeas, limited, realIp } from "./ideas.js";
import { statsOf } from "./referrals.js";
import { maintenancePublic, setMaintenance, startMaintenance } from "./maintenance.js";
import { matchById, matchByTx, matchesByHash, matchesOfWallet, recentMatches, storedReplay } from "./archive.js";

// A rate limited RPC answer must never take the server down: log it and keep serving (rooms in memory would be lost).
process.on("uncaughtException", (e) => log("uncaught_exception", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
process.on("unhandledRejection", (e) => log("unhandled_rejection", { error: String((e as Error)?.message ?? e).slice(0, 200) }));

const hub = new Hub();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true, cluster: config.cluster, programId: config.programId, devBots: config.devBots, rooms: hub.rooms.size, clients: hub.clients.size, matchesRunning: hub.matchesRunning(), maintenance: maintenancePublic(), revision: process.env.K_REVISION ?? null }));
    return;
  }
  const m = /^\/replay\/([0-9A-Za-z_-]{1,40})\/([0-9A-Za-z_]{1,64})$/.exec(req.url ?? "");
  if (m) {
    void (async () => {
      const b = hub.replayOf(m[1], m[2]) ?? (await storedReplay(m[1], m[2]));
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
    res.end(JSON.stringify({ duels: hub.liveDuels() }));
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
    void statsOf(rf[1]).then(
      (j) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }); res.end(JSON.stringify(j)); },
      () => { res.writeHead(502, { "access-control-allow-origin": "*" }).end(); },
    );
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
    const qs = new URL(req.url ?? "", "http://x").searchParams;
    const limit = Number(qs.get("limit") ?? 20);
    const beforeRaw = qs.get("before");
    const before = beforeRaw !== null && /^\d{10,16}$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
    const modeRaw = qs.get("mode");
    const mode = modeRaw === "royale" || modeRaw === "vs" || modeRaw === "duel" ? modeRaw : undefined;
    void recentMatches(Number.isFinite(limit) ? limit : 20, before, mode).then((j) => send(200, j), () => send(502, { error: "archive" }));
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
        if (q[1] === "wallet") return send(200, { items: await matchesOfWallet(q[2]) });
        if (q[1] === "tx") return send(200, { items: await matchByTx(q[2]) });
        if (q[1] === "hash") return send(200, { items: await matchesByHash(q[2].toLowerCase()) });
        const one = await matchById(q[2]);
        return send(200, { items: one ? [one] : [] });
      } catch {
        send(502, { error: "archive" });
      }
    })();
    return;
  }
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
  const c = hub.connect(ws);
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

await startCounters();
await startIdeas();
startMaintenance();
hub.start();
process.on("SIGTERM", () => void Promise.all([flush(), flushIdeas()]).finally(() => process.exit(0)));

// Only the newest revision may run matches. Cloud Run keeps an old instance alive while it holds sockets (up to an hour),
// and two hubs would start two matches for the same room. Every 20 s the instance asks its own public address which
// revision answers; when it is not this one, it steps down and exits, and the clients reconnect to the new one.
const SELF = process.env.SELF_URL;
const ME = process.env.K_REVISION;
if (SELF && ME) {
  setInterval(async () => {
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
