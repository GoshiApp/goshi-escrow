import { test } from "node:test";
import assert from "node:assert/strict";
import { Arena, arenaBrain } from "../src/game/arena.ts";
import { arenaReplayHash, encodeArenaReplay, replayArena } from "../src/game/arena-replay.ts";

test("a whole arena match replays from its record to the same result", () => {
  const roster = Array.from({ length: 8 }, (_, i) => ({ w: `p${i}`, n: `P${i}`, role: (i >= 6 ? "saboteur" : "paid") as "paid" | "saboteur", bot: true }));
  const a = new Arena(4242, roster, { matchMs: 40_000, shrinkStartMs: 10_000 });
  const startMass = a.players.map((p) => ({ w: p.w, n: p.n, role: p.role, bot: p.bot, m: p.m }));
  while (!a.finished() && a.time * 1000 < 40_000) a.step(1 / 20, arenaBrain);
  const bytes = encodeArenaReplay(4242, 40_000, 10_000, startMass, a.inputLog);
  assert.ok(bytes.length > 100);
  const b = replayArena(bytes);
  assert.deepEqual(b.ranking(), a.ranking());
  assert.deepEqual(b.players.map((p) => Math.round(p.m * 10)), a.players.map((p) => Math.round(p.m * 10)));
  assert.equal(b.orbs.length, a.orbs.length);
  assert.equal(arenaReplayHash(bytes).length, 64);
});
