// Converts a match record (the file "Download the full match record" on goshi.app) into JSON with every frame.
//   npx tsx scripts/replay-to-json.ts record.bin > match.json      (add --every=N to keep one frame in N; default 1 = 20 per second)
// Uses the same rules as the server (src/game/arena.ts), so the output is the match exactly as it was played.
import { readFileSync } from "node:fs";
import { Arena, bodyPoints, bodyRadius } from "../src/game/arena.js";
import { decodeArenaReplay } from "../src/game/arena-replay.js";

const file = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
if (!file) { console.error("usage: replay-to-json.ts <record file> [--every=N]"); process.exit(1); }
const every = Math.max(1, Number(process.argv.find((a) => a.startsWith("--every="))?.slice(8)) || 1);
const rec = decodeArenaReplay(new Uint8Array(readFileSync(file)));
const arena = new Arena(rec.seed, rec.players, { matchMs: rec.matchMs, shrinkStartMs: rec.shrinkStartMs });
rec.players.forEach((p, i) => { arena.players[i].m = p.m; arena.players[i].peak = p.m; });
const r1 = (n: number) => Math.round(n * 10) / 10;
const frames: unknown[] = [];
let k = 0;
for (let tick = 0; !arena.finished() && arena.time * 1000 < rec.matchMs; tick++) {
  while (k < rec.log.length && rec.log[k][0] === tick) {
    const [, pi, ab, f] = rec.log[k++];
    const p = arena.players[pi];
    const hd = (ab / 256) * Math.PI * 2;
    p.dx = Math.cos(hd); p.dy = Math.sin(hd); p.boost = f === 1;
  }
  arena.step(1 / 20);
  if (tick % every === 0) {
    const z = arena.zoneNow();
    frames.push({
      tick, t: r1(arena.time), zone: { cx: r1(z.cx), cy: r1(z.cy), r: r1(z.r), phase: z.phase },
      players: arena.players.map((p) => ({ w: p.w, alive: p.alive, m: r1(p.m), r: r1(bodyRadius(p.m)), head: [r1(p.x), r1(p.y)], body: p.alive ? bodyPoints(p).slice(1).map((q) => [Math.round(q[0]), Math.round(q[1])]) : [] })),
    });
  }
}
console.log(JSON.stringify({
  format: "goshi-arena-replay-json/1", seed: rec.seed, matchMs: rec.matchMs, world: { w: 3000, h: 3000 },
  players: rec.players.map((p) => ({ w: p.w, role: p.role, bot: p.bot, startMass: p.m })),
  ranking: arena.ranking(), frames,
}));
