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

test("a dropped connection (bot plays, protected) and the return are in the record and the match replays exactly", () => {
  const roster = Array.from({ length: 6 }, (_, i) => ({ w: `p${i}`, n: `P${i}`, role: "paid" as const, bot: i >= 2 }));
  const a = new Arena(777, roster, { matchMs: 60_000, shrinkStartMs: 8_000 });
  const startMass = a.players.map((p) => ({ w: p.w, n: p.n, role: p.role, bot: p.bot, m: p.m }));
  let covered = 0;
  let tick = 0;
  while (!a.finished() && a.time * 1000 < 60_000) {
    // The two people steer by hand (a slow circle); p0 drops at tick 200 and comes back at 600, p1 drops at 300 and stays away.
    for (const w of ["p0", "p1"]) a.setInput(w, Math.cos(tick / 40), Math.sin(tick / 40), tick % 90 < 10);
    if (tick === 200 && a.away("p0")) covered++;
    if (tick === 300 && a.away("p1")) covered++;
    if (tick === 600) assert.equal(a.back("p0"), true);
    a.step(1 / 20, arenaBrain);
    tick++;
  }
  assert.equal(covered, 2);
  const flags = a.inputLog.filter((e) => e[3] >= 2).map((e) => e[3]);
  assert.ok(flags.includes(2) && flags.includes(3));
  const bytes = encodeArenaReplay(777, 60_000, 8_000, startMass, a.inputLog);
  const b = replayArena(bytes);
  assert.deepEqual(b.ranking(), a.ranking());
  assert.deepEqual(b.players.map((p) => Math.round(p.m * 10)), a.players.map((p) => Math.round(p.m * 10)));
  assert.deepEqual(b.players.map((p) => p.alive), a.players.map((p) => p.alive));
});

test("a body cannot be covered more than twice in a match", () => {
  const roster = [{ w: "h", n: "H", role: "paid" as const, bot: false }, { w: "x", n: "X", role: "paid" as const, bot: true }];
  const a = new Arena(5, roster, { matchMs: 30_000, shrinkStartMs: 8_000 });
  assert.equal(a.away("h"), true);
  a.step(1 / 20, arenaBrain);
  assert.equal(a.back("h"), true);
  a.step(1 / 20, arenaBrain);
  assert.equal(a.away("h"), true);
  a.step(1 / 20, arenaBrain);
  assert.equal(a.back("h"), true);
  a.step(1 / 20, arenaBrain);
  assert.equal(a.away("h"), false);
});

test("a body played by the bot while its person is away shrinks, eats nothing and is shielded only for a short time", () => {
  const roster = [{ w: "h", n: "H", role: "paid" as const, bot: false }, { w: "x", n: "X", role: "paid" as const, bot: true }];
  const a = new Arena(11, roster, { matchMs: 120_000, shrinkStartMs: 100_000 });
  const h = a.players[0];
  for (let i = 0; i < 200; i++) a.step(1 / 20, arenaBrain); // past the opening protection
  assert.equal(a.away("h"), true);
  a.step(1 / 20, arenaBrain);
  const m0 = h.m;
  const until = h.protectUntil;
  assert.ok(until - a.time > 18 && until - a.time <= 20.1, "about 20 seconds of shield");
  for (let i = 0; i < 100; i++) a.step(1 / 20, arenaBrain);
  assert.ok(h.m < m0, "it loses mass");
  assert.ok(h.m >= 12, "never below the minimum mass: the drain alone does not kill");
  assert.equal(h.alive, true);
  assert.equal(a.back("h"), true);
  a.step(1 / 20, arenaBrain);
  const m1 = h.m;
  for (let i = 0; i < 40; i++) a.step(1 / 20, arenaBrain);
  assert.ok(h.m >= m1, "back at the keys the body stops shrinking");
});

test("a record carries its rules version and each version replays with its own rules", () => {
  const ents = (n: number, free = 0) =>
    Array.from({ length: n }, (_, i) => ({ w: `W${i}`, n: `P${i}`, role: (i >= n - free ? "saboteur" : "paid") as "paid" | "saboteur", bot: true }));
  for (const rules of [1, 2] as const) {
    const a = new Arena(99, ents(6, 1), { matchMs: 30_000, shrinkStartMs: 8_000, rules });
    while (!a.finished() && a.time * 1000 < 30_000) a.step(0.05, arenaBrain);
    const start = a.players.map((p) => ({ w: p.w, n: p.n, role: p.role, bot: p.bot, m: 20 }));
    const bytes = encodeArenaReplay(99, 30_000, 8_000, start, a.inputLog, rules);
    assert.equal(Buffer.from(bytes).toString("latin1", 0, 3), rules === 1 ? "GA\x01" : "GA\x02");
    const b = replayArena(bytes);
    assert.equal(b.rules, rules);
    assert.deepEqual(b.ranking().map((r) => r.w), a.ranking().map((r) => r.w));
  }
});
