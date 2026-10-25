import test from "node:test";
import assert from "node:assert/strict";
import { Arena, ARENA, arenaBrain, bodyPoints, bodyRadius, segmentCount, speedOf, zoneState, zoneDamagePerSecond, ZONE_RADII, ZONE_PHASES } from "../src/game/arena.ts";

const ents = (n: number, free = 0) =>
  Array.from({ length: n }, (_, i) => ({ w: `W${i}`, n: `P${i}`, role: (i >= n - free ? "saboteur" : "paid") as "paid" | "saboteur", bot: true }));

const place = (a: Arena, w: string, x: number, y: number, heading = 0) => {
  a.time = Math.max(a.time, ARENA.protectSeconds + 0.1); // spawn protection is covered by its own test
  const p = a.player(w)!;
  p.x = x; p.y = y; p.heading = heading; p.dx = Math.cos(heading); p.dy = Math.sin(heading); p.trail = [];
  return p;
};
const lay = (p: ReturnType<Arena["player"]> & {}, pts: [number, number][]) => { p.trail = pts.map((q) => [q[0], q[1]] as [number, number]); };

test("same seed gives the same match", () => {
  const run = (seed: number) => {
    const a = new Arena(seed, ents(13, 3));
    for (let i = 0; i < 20 * 60; i++) a.step(0.05, arenaBrain);
    return JSON.stringify(a.ranking());
  };
  assert.equal(run(5), run(5));
  assert.notEqual(run(5), run(6));
});

test("a head that touches a rival's solid body dies at once, the rival survives", () => {
  const a = new Arena(1, ents(2));
  const rival = place(a, "W1", 1500, 1500, 0);
  // A horizontal body behind the rival's head.
  lay(rival, Array.from({ length: 60 }, (_, i) => [1500 - 4 * (i + 1), 1500] as [number, number]));
  rival.m = 40;
  const hit = place(a, "W0", 1470, 1450, Math.PI / 2); // heading down into the body at x 1470
  hit.m = 20;
  let r;
  for (let i = 0; i < 40 && hit.alive; i++) r = a.step(0.05);
  assert.equal(hit.alive, false);
  assert.equal(hit.killer, "W1");
  assert.equal(a.player("W1")!.alive, true);
});

test("a player's own body is harmless", () => {
  const a = new Arena(1, ents(2));
  const p = place(a, "W0", 1500, 1500, 0);
  lay(p, Array.from({ length: 60 }, (_, i) => [1500 - 4 * (i + 1), 1500] as [number, number]));
  place(a, "W1", 100, 100, 0);
  for (let i = 0; i < 10; i++) a.step(0.05);
  assert.equal(p.alive, true);
});

test("head against head: the lighter dies, equal masses both die", () => {
  let a = new Arena(1, ents(2));
  place(a, "W0", 1500, 1500, 0).m = 30;
  place(a, "W1", 1503, 1500, Math.PI).m = 20;
  a.step(0.001);
  assert.equal(a.player("W0")!.alive, true);
  assert.equal(a.player("W1")!.alive, false);

  a = new Arena(1, ents(2));
  place(a, "W0", 1500, 1500, 0).m = 25;
  place(a, "W1", 1503, 1500, Math.PI).m = 25;
  a.step(0.001);
  assert.equal(a.player("W0")!.alive, false);
  assert.equal(a.player("W1")!.alive, false);
});

test("death drops 100% of the mass as orbs on the exact path of the body (rules 1)", () => {
  const a = new Arena(2, ents(2), { rules: 1 });
  const victim = place(a, "W0", 2995, 1500, 0); // runs into the east edge
  victim.m = 87.5;
  lay(victim, Array.from({ length: 90 }, (_, i) => [2995 - 4 * (i + 1), 1500] as [number, number]));
  let ev = a.step(0.05);
  let all = [...ev.newOrbs];
  for (let i = 0; i < 20 && victim.alive; i++) { ev = a.step(0.05); all = all.concat(ev.newOrbs); }
  assert.equal(victim.alive, false);
  assert.equal(victim.killer, "wall");
  // The death orbs sit on the horizontal path (y 1500, between the tail and the edge) and carry the whole mass.
  const deathOrbs = all.filter((o) => o.y === 1500 && o.x > 2500 && o.x <= 3010);
  const sum = deathOrbs.reduce((s, o) => s + o.v, 0);
  assert.ok(Math.abs(sum - victim.peak) < 0.5 || Math.abs(sum - 87.5) < 0.5, `death orbs carry ${sum}`);
  assert.ok(deathOrbs.length <= ARENA.maxDeathOrbs && deathOrbs.length > 1);
});

test("the world edge kills", () => {
  const a = new Arena(1, ents(2));
  place(a, "W0", ARENA.w - 1, 1500, 0);
  const ev = a.step(0.2);
  assert.equal(a.player("W0")!.alive, false);
  assert.deepEqual(ev.deaths.find((d) => d.w === "W0")?.by, "wall");
});

test("outside the zone mass drains 8% per second and the player dies under 5", () => {
  const a = new Arena(1, ents(2));
  a.time = 250; // the zone is small by now
  const p = place(a, "W0", 1500 + 1200, 1500, 0);
  p.dx = 1; p.dy = 0;
  p.m = 20;
  const start = p.m;
  a.step(0.5);
  assert.ok(p.m < start);
  let by = "";
  for (let i = 0; i < 400 && p.alive; i++) { const e = a.step(0.05); const d = e.deaths.find((x) => x.w === "W0"); if (d) by = d.by; }
  assert.equal(p.alive, false);
  assert.ok(by === "zone" || by === "wall");
});

test("ranking: alive by mass, then dead by later death first, ties by wallet", () => {
  const a = new Arena(1, ents(5));
  const [p0, p1, p2, p3, p4] = a.players;
  p0.m = 50; p1.m = 80; p2.alive = false; p2.diedAt = 100; p3.alive = false; p3.diedAt = 200; p4.alive = false; p4.diedAt = 200;
  const r = a.ranking().map((x) => x.w);
  assert.deepEqual(r, ["W1", "W0", "W3", "W4", "W2"]);
});

test("body length and width grow with mass within limits", () => {
  assert.equal(segmentCount(0), 6);
  assert.equal(segmentCount(20), 12);
  assert.equal(segmentCount(100000), 150);
  assert.ok(bodyRadius(100) > bodyRadius(20));
});

test("a full 13 player match (10 paid, 3 saboteurs) runs without NaN and ranks everyone", () => {
  const a = new Arena(11, ents(13, 3));
  let ticks = 0;
  while (!a.finished() && ticks < 20 * 310) { a.step(0.05, arenaBrain); ticks++; }
  for (const p of a.players) {
    assert.ok(Number.isFinite(p.m) && Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  const r = a.ranking();
  assert.equal(r.length, 13);
  assert.equal(new Set(r.map((x) => x.w)).size, 13);
  assert.deepEqual(r.map((x) => x.rank), Array.from({ length: 13 }, (_, i) => i + 1));
});

test("input is clamped and ignored for the dead", () => {
  const a = new Arena(1, ents(2));
  a.setInput("W0", 9, 9, true);
  const p = a.player("W0")!;
  assert.ok(Math.hypot(p.dx, p.dy) <= 1.0000001);
  p.alive = false;
  a.setInput("W0", -1, 0, false);
  assert.ok(p.dx > 0);
  a.setInput("nobody", 1, 1, false);
});

test("nobody can die during the first seconds of the match", () => {
  const a = new Arena(1, ents(2));
  const rival = a.player("W1")!;
  rival.x = 1500; rival.y = 1500;
  rival.trail = Array.from({ length: 60 }, (_, i) => [1500 - ARENA.trailSpacing * (i + 1), 1500] as [number, number]);
  const hit = a.player("W0")!;
  hit.x = 1480; hit.y = 1495; hit.heading = 0; hit.dx = 1; hit.dy = 0;
  a.step(0.05);
  assert.equal(hit.alive, true, "protected at the start");
  a.time = ARENA.protectSeconds + 1;
  hit.x = 1480; hit.y = 1500;
  a.step(0.05);
  assert.equal(hit.alive, false, "mortal after the protection");
});

test("a head is wide and slow enough to see: about 15 units and 9 radii per second", () => {
  const r = bodyRadius(ARENA.startMass);
  assert.ok(r > 13 && r < 17);
  assert.ok(Math.abs(speedOf(ARENA.startMass) / r - 8.4) < 1.5);
});

test("the zone moves in five phases: announced, then moving, then holding, always inside the previous circle", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const a = new Arena(seed, ents(3));
    const plan = a.zonePlan;
    // Nested plan: every next circle fits inside the previous one and is off center sooner or later.
    for (let i = 0; i < ZONE_PHASES; i++) {
      const d = Math.hypot(plan.centers[i + 1].x - plan.centers[i].x, plan.centers[i + 1].y - plan.centers[i].y);
      assert.ok(d + ZONE_RADII[i + 1] <= ZONE_RADII[i] + 1e-9, `phase ${i} nested`);
    }
    // Over time: radius never grows and every zone is inside the one before.
    let prev = zoneState(0, plan);
    for (let t = 0; t <= 300; t += 0.5) {
      const z = zoneState(t, plan);
      assert.ok(z.r <= prev.r + 1e-9, "radius never grows");
      assert.ok(Math.hypot(z.cx - prev.cx, z.cy - prev.cy) + z.r <= prev.r + 1e-6, `nested at ${t}`);
      prev = z;
    }
    const end = zoneState(300, plan);
    assert.equal(end.r, ZONE_RADII[ZONE_PHASES]);
    assert.ok(Math.abs(end.cx - plan.centers[ZONE_PHASES].x) < 1e-9);
  }
});

test("phases follow the schedule: calm, announced, moving, holding", () => {
  const a = new Arena(4, ents(3));
  const plan = a.zonePlan;
  assert.equal(zoneState(10, plan).state, "calm");
  assert.equal(zoneState(10, plan).target, null);
  assert.equal(zoneState(116, plan).state, "warn"); // 5 s before the first shrink the target is shown
  assert.ok(zoneState(116, plan).target);
  // Phase 1 starts at 120 s; one phase is 36 s: warn 7.2 s, shrink 12.6 s, then hold.
  assert.equal(zoneState(124, plan).state, "warn");
  assert.equal(zoneState(130, plan).state, "shrink");
  assert.equal(zoneState(145, plan).state, "hold");
  assert.equal(zoneState(145, plan).phase, 1);
  assert.equal(zoneState(156.5, plan).phase, 2);
  // While moving the radius is between the two circles.
  const mid = zoneState(130, plan);
  assert.ok(mid.r < ZONE_RADII[1] + 400 && mid.r > ZONE_RADII[1]);
});

test("different matches get different centers", () => {
  const c1 = new Arena(1, ents(3)).zonePlan.centers[ZONE_PHASES];
  const c2 = new Arena(2, ents(3)).zonePlan.centers[ZONE_PHASES];
  assert.notDeepEqual(c1, c2);
});

test("outside the zone mass drains fast and constantly, harsher in later phases", () => {
  assert.ok(zoneDamagePerSecond(20, 1) >= 5);
  assert.ok(zoneDamagePerSecond(300, 1) >= 33);
  assert.ok(zoneDamagePerSecond(100, 4) > zoneDamagePerSecond(100, 1));
});

test("camping in the middle is punished: a player that never moves from the center is out of the zone at the end", () => {
  const a = new Arena(3, ents(2));
  const camper = a.player("W0")!;
  const cx = ARENA.w / 2, cy = ARENA.h / 2;
  camper.protectUntil = 0;
  for (let i = 0; i < 20 * 300 && camper.alive; i++) {
    // Hold the position in the middle: cancel any movement each tick.
    camper.x = cx; camper.y = cy; camper.trail = [];
    a.step(0.05);
    a.player("W1")!.alive && (a.player("W1")!.x = 100, a.player("W1")!.y = 100);
  }
  assert.equal(camper.alive, false, "the center is not safe at the end");
  assert.equal(camper.killer, "zone");
});

test("survival: a dominant head that hits the middle of a small body is not killed but pays mass for the knock", () => {
  const a = new Arena(3, ents(2), { matchMs: 3600_000, shrinkStartMs: 3600_000, survival: true });
  const small = place(a, "W1", 1500, 1500, 0);
  small.m = 25;
  lay(small, Array.from({ length: 40 }, (_, i) => [1500 - 4 * (i + 1), 1500] as [number, number]));
  const big = place(a, "W0", 1450, 1506, 0);
  big.m = 90;
  big.protectUntil = 0; small.protectUntil = 0;
  a.orbs.length = 0;
  a.step(0.05);
  assert.equal(big.alive, true, "the heavy body is not killed by the small one's body");
  assert.ok(big.m < 90, "it lost mass for the knock");
  assert.ok(small.m >= 25 - 1e-9 && small.alive, "the small one is not hurt");
});

test("survival: a body five times heavier eats the tail of a small one, mass for mass", () => {
  const a = new Arena(3, ents(2), { matchMs: 3600_000, shrinkStartMs: 3600_000, survival: true });
  const small = place(a, "W1", 1500, 1500, 0);
  small.m = 25;
  lay(small, Array.from({ length: 40 }, (_, i) => [1500 - 4 * (i + 1), 1500] as [number, number]));
  const pts = bodyPoints(small);
  const tail = pts[pts.length - 1];
  const big = place(a, "W0", tail[0], tail[1] + 4, 0);
  big.m = 200;
  big.protectUntil = 0; small.protectUntil = 0;
  a.orbs.length = 0;
  const total = big.m + small.m;
  a.step(0.05);
  assert.ok(big.m > 200 && small.m < 25, `the tail moved to the big one (${big.m}, ${small.m}, ${big.alive}, ${small.alive})`);
  assert.ok(Math.abs(big.m + small.m - total) < 1e-6, "nothing is lost or made up");
});

test("rules 1: the same touch kills the one that touched (a heavy body is not spared)", () => {
  const a = new Arena(3, ents(2), { rules: 1 });
  const small = place(a, "W1", 1500, 1500, 0);
  small.m = 25;
  lay(small, Array.from({ length: 40 }, (_, i) => [1500 - 4 * (i + 1), 1500] as [number, number]));
  const big = place(a, "W0", 1450, 1506, 0);
  big.m = 90;
  big.protectUntil = 0; small.protectUntil = 0;
  a.step(0.05);
  assert.equal(big.alive, false);
});

test("rules 2: a death leaves richer orbs the heavier the body was, and rules 1 stays exact", () => {
  const drop = (rules: 1 | 2, m: number) => {
    const a = new Arena(2, ents(2), { rules });
    const v = place(a, "W0", 2995, 1500, 0);
    v.m = m;
    lay(v, Array.from({ length: 200 }, (_, i) => [2995 - 4 * (i + 1), 1500] as [number, number]));
    let all: { v: number }[] = [];
    for (let i = 0; i < 30 && v.alive; i++) all = all.concat(a.step(0.05).newOrbs.filter((o) => o.y === 1500 && o.x > 1000));
    return all.reduce((s, o) => s + o.v, 0);
  };
  assert.ok(Math.abs(drop(1, 600) / 600 - 1) < 0.03, "rules 1 returns the mass (less what the edge took first)");
  const light = drop(2, 60), heavy = drop(2, 3000);
  assert.ok(light / 60 > 0.98 && light / 60 < 1.1, `a light body: ${light / 60}`);
  assert.ok(heavy / 3000 > 1.3 && heavy / 3000 <= 1.5 + 1e-6, `a very heavy body: ${heavy / 3000}`);
});

test("rules 2: a heavy body is not much slower and every body looks as big as it is", () => {
  const a1 = new Arena(1, ents(2), { rules: 1 });
  const s1 = [speedOf(20), speedOf(1000)], r1 = [bodyRadius(20), bodyRadius(1000)];
  const a2 = new Arena(1, ents(2), { rules: 2 });
  assert.equal(a2.rules, 2);
  const s2 = [speedOf(20), speedOf(1000)], r2 = [bodyRadius(20), bodyRadius(1000)];
  assert.ok(s2[1] / s2[0] > s1[1] / s1[0] + 0.3, "the giant keeps much more of its speed");
  assert.ok(r2[1] > r1[1] * 1.3, "a body of 1000 mass is drawn clearly bigger");
  void a1;
});
