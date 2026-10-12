import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_USD, FRENZY, Recorder, SYMBOLS, angleByte, buildMap, carriedMass, decodeReplay, encodeReplay, frenzyBrain,
  gemMass, laserActive, makeSnapshot, newPlayer, replayHash, simulate, stepPlayer,
} from "../src/game/frenzy.ts";

const snap = makeSnapshot({ ...FALLBACK_USD }, "fallback", 1_700_000_000_000);

test("gem mass: base per tier, compressed ratio, held inside the tier range", () => {
  assert.equal(snap.mass.SOL, 1);
  assert.equal(snap.mass.DOGE, 1);
  assert.ok(snap.mass.ETH >= 3 && snap.mass.ETH <= 5);
  assert.ok(snap.mass.BTC >= 5 && snap.mass.BTC <= 8);
  // The price never lifts a gem above its tier, and a crash never drops it below.
  assert.equal(gemMass("BTC", { ...FALLBACK_USD, BTC: 1 }), 5);
  assert.equal(gemMass("BTC", { ...FALLBACK_USD, BTC: 1e9 }), 8);
  assert.equal(gemMass("ETH", { ...FALLBACK_USD, ETH: 1 }), 3);
  assert.equal(gemMass("SOL", { ...FALLBACK_USD, SOL: 0 }), 1);
});

test("the snapshot hash is stable and changes with any price", () => {
  const again = makeSnapshot({ ...FALLBACK_USD }, "fallback", 1_700_000_000_000);
  assert.equal(again.hash, snap.hash);
  assert.notEqual(makeSnapshot({ ...FALLBACK_USD, ETH: 3501 }, "fallback", 1_700_000_000_000).hash, snap.hash);
  assert.equal(snap.hash.length, 64);
  assert.equal(SYMBOLS.length, 6);
});

test("the map is the same for the same seed and snapshot, different for another seed", () => {
  const a = buildMap(12345, snap);
  const b = buildMap(12345, snap);
  assert.deepEqual(a, b);
  assert.notDeepEqual(buildMap(54321, snap).gems.slice(0, 20), a.gems.slice(0, 20));
  assert.equal(a.gems.filter((g) => g.btc).length, 3);
  assert.ok(a.gems.length > 450);
  // No gem sits inside a wall.
  for (const g of a.gems) assert.ok(!a.walls.some((q) => g.x > q.x && g.x < q.x + q.w && g.y > q.y && g.y < q.y + q.h));
  // The start is clear.
  assert.ok(!a.walls.some((q) => FRENZY.startX > q.x && FRENZY.startX < q.x + q.w && FRENZY.startY > q.y && FRENZY.startY < q.y + q.h));
});

test("a minute of input replays to the same state, bit for bit", () => {
  const map = buildMap(777, snap);
  const live = newPlayer();
  const rec = new Recorder();
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let angle = 0;
  let nitro = false;
  for (let t = 1; t <= FRENZY.ticks; t++) {
    if (t % 17 === 0) angle = Math.floor(rnd() * 256);
    if (t % 53 === 0) nitro = rnd() < 0.5;
    live.angle = angle;
    live.nitro = nitro;
    rec.note(t, angle, nitro);
    stepPlayer(map, live);
  }
  const bytes = encodeReplay(777, snap.hash, rec.entries);
  assert.ok(bytes.length < 3000, `replay is ${bytes.length} bytes`);
  const dec = decodeReplay(bytes);
  assert.equal(dec.seed, 777);
  assert.equal(dec.snapshotPrefix, snap.hash.slice(0, 16));
  const re = simulate(map, dec.entries);
  assert.equal(re.m, live.m);
  assert.equal(re.x, live.x);
  assert.equal(re.y, live.y);
  assert.equal(re.eaten, live.eaten);
  assert.equal(replayHash(bytes).length, 64);
});

test("a player that has not touched the controls stands still, and the replay knows it", () => {
  const map = buildMap(5, snap);
  const live = newPlayer();
  const rec = new Recorder();
  for (let t = 1; t <= 100; t++) {
    const touched = t > 40;
    live.angle = touched ? 64 : 0;
    live.hold = !touched;
    rec.note(t, live.angle, false, live.hold);
    stepPlayer(map, live);
  }
  const bytes = encodeReplay(5, snap.hash, rec.entries);
  const re = simulate(map, decodeReplay(bytes).entries, 100);
  assert.equal(re.x, live.x);
  assert.equal(re.y, live.y);
  assert.ok(Math.abs(live.x - FRENZY.startX) < 1, "x did not move while holding");
  assert.ok(live.y > FRENZY.startY + 100, "moved down after the first input");
});

test("walls stop a player and a burning laser costs a quarter of the mass once", () => {
  const map = buildMap(31, snap);
  const l = map.lasers.find((q) => q.w === 10 || q.h === 10)!;
  const p = newPlayer();
  p.x = l.x + l.w / 2;
  p.y = l.y + l.h / 2 - 30;
  p.m = 40;
  p.angle = angleByte(0, 1); // down, into the laser
  // Find a tick where it burns.
  let t = 0;
  while (!laserActive(l, t + 1)) t++;
  p.tick = t;
  let hit = false;
  for (let i = 0; i < 40 && !hit; i++) hit = stepPlayer(map, p).hit;
  assert.ok(hit);
  assert.ok(p.m <= 30.5 && p.m >= 29, `mass ${p.m}`);
  assert.ok(p.stun > 0);
});

test("a bot that follows its brain collects gems and the result is replayable", () => {
  const map = buildMap(4242, snap);
  const p = newPlayer();
  const rec = new Recorder();
  for (let t = 1; t <= FRENZY.ticks; t++) {
    const a = frenzyBrain(map, p, 0);
    p.angle = a.angle;
    p.nitro = a.nitro;
    rec.note(t, a.angle, a.nitro);
    stepPlayer(map, p);
  }
  assert.ok(p.eaten > 20, `ate ${p.eaten}`);
  assert.ok(p.m > FRENZY.startMass + 20);
  const re = simulate(map, rec.entries);
  assert.equal(re.m, p.m);
  assert.ok(carriedMass(p.m) <= FRENZY.carryCap);
});
