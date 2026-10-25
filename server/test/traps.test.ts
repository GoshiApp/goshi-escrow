import test from "node:test";
import assert from "node:assert/strict";
import { Arena, TRAP_LASER, TRAP_SLOW, bodyPoints } from "../src/game/arena.ts";

const two = () => new Arena(7, [
  { w: "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", n: "A", role: "paid", bot: false },
  { w: "Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", n: "B", role: "paid", bot: false },
], { matchMs: 120_000, shrinkStartMs: 100_000 });

test("a laser takes a tenth of the mass of a head that touches it, once, gives it to its owner and never kills", () => {
  const a = two();
  for (const p of a.players) p.protectUntil = 0;
  const [A, B] = a.players;
  for (let i = 0; i < 20; i++) a.step(0.05);
  B.m = 500; A.m = 100;
  assert.ok(a.queueTrap(0, TRAP_LASER));
  a.step(0.05);
  const t = a.traps[0];
  // A goes far away with no body, so only the beam can touch B.
  A.x = 200; A.y = 200; A.trail = [];
  B.x = (t.x + t.x2) / 2; B.y = (t.y + t.y2) / 2; B.dx = 0; B.dy = 0; B.trail = [];
  const mB = B.m, mA = A.m;
  const ev = a.step(0.05);
  assert.equal(ev.deaths.length, 0);
  assert.ok(B.alive);
  assert.ok(Math.abs(mB - B.m - mB * 0.1) < 2, `${mB} -> ${B.m}`);
  assert.ok(A.m - mA > mB * 0.1 - 2);
  // Once per head: staying on the beam takes nothing more.
  const m2 = B.m;
  B.x = (t.x + t.x2) / 2; B.y = (t.y + t.y2) / 2;
  a.step(0.05);
  assert.ok(Math.abs(B.m - m2) < 2);
  for (let i = 0; i < 70; i++) a.step(0.05);
  assert.equal(a.traps.length, 0);
});

test("a puddle halves the speed of the others and is written in the record", () => {
  const a = two();
  for (let i = 0; i < 20; i++) a.step(0.05);
  a.queueTrap(0, TRAP_SLOW);
  a.step(0.05);
  const t = a.traps[0];
  const B = a.players[1];
  B.x = t.x; B.y = t.y; B.heading = 0; B.dx = 1; B.dy = 0;
  const x0 = B.x;
  a.step(0.05);
  const inside = B.x - x0;
  B.x = 100; B.y = 100;
  const x1 = B.x;
  a.step(0.05);
  assert.ok(Math.abs(inside - (B.x - x1) / 2) < 0.5, `${inside} vs ${B.x - x1}`);
  assert.ok(a.inputLog.some((e) => e[3] === 4 && e[2] === TRAP_SLOW));
  void bodyPoints;
});

test("no traps before rules 3", () => {
  const a = new Arena(1, [{ w: "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", n: "A", role: "paid", bot: false }], { rules: 2 });
  assert.equal(a.queueTrap(0, TRAP_LASER), false);
});
