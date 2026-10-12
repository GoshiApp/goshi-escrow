import http from "node:http";
import { WebSocketServer } from "ws";
import { authorityPubkey } from "./chain.js";
import { config, log } from "./config.js";
import { Hub } from "./rooms.js";

// A rate limited RPC answer must never take the server down: log it and keep serving (rooms in memory would be lost).
process.on("uncaughtException", (e) => log("uncaught_exception", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
process.on("unhandledRejection", (e) => log("unhandled_rejection", { error: String((e as Error)?.message ?? e).slice(0, 200) }));

const hub = new Hub();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true, cluster: config.cluster, programId: config.programId, devBots: config.devBots, rooms: hub.rooms.size, clients: hub.clients.size, revision: process.env.K_REVISION ?? null }));
    return;
  }
  const m = /^\/replay\/([0-9A-Za-z_-]{1,40})\/([0-9A-Za-z_]{1,64})$/.exec(req.url ?? "");
  if (m) {
    const b = hub.replayOf(m[1], m[2]);
    if (!b) return void res.writeHead(404, { "access-control-allow-origin": "*" }).end();
    res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" });
    res.end(Buffer.from(b));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  // Snapshots are repetitive JSON: deflate shrinks them a lot, which matters on mobile and long distance links.
  perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
  verifyClient: ({ origin }: { origin?: string }) => !origin || config.allowedOrigins.includes(origin),
});

wss.on("connection", (ws) => {
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

hub.start();

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
