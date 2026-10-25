import test from "node:test";
import assert from "node:assert/strict";
import { Arena, arenaBrain, bodyPoints } from "../src/game/arena.ts";

test("survival: the map grows with the leader, shrinks back when it dies, and a body has no length limit", () => {
  const ents = Array.from({ length: 6 }, (_, i) => ({ w: `W${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, n: `P${i}`, role: "paid" as const, bot: true }));
  const a = new Arena(9, ents, { survival: true, matchMs: 6 * 3600_000 });
  const r0 = a.mapR;
  a.players[0].m = 200_000;
  for (let i = 0; i < 20 * 60; i++) a.step(0.05, arenaBrain);
  assert.ok(a.mapR > r0 * 5, `grew to ${a.mapR}`);
  // No cap: the points of a 200 000 body are further apart than the old maximum of 40 (so it can be longer than 6000).
  const pts = bodyPoints(a.players[0]);
  const gap = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  assert.ok(gap > 41, `gap ${gap}`);
  const big = a.mapR;
  a.players[0].alive = false; a.players[0].m = 0;
  for (let i = 0; i < 20 * 10; i++) a.step(0.05, arenaBrain);
  assert.ok(a.mapR < big - 300, "it shrinks slowly once the leader is gone");
  assert.ok(a.mapR > big - 600, "but not at once");
});
