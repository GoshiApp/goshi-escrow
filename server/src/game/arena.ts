// Battle royale arena with solid bodies. Pure and deterministic: no network, no clock, no I/O.
// The rules are in server/PROTOCOL.md (section "Game rules").

export const ARENA = {
  w: 3000,
  h: 3000,
  matchMs: 300_000,
  shrinkStartMs: 120_000,
  tickRate: 20,
  zoneR0: 1450,
  zoneRMin: 150,
  startMass: 20,
  minMass: 12,
  orbTarget: 600,
  orbValues: [1, 2, 4] as const,
  maxBodySegments: 150,
  segmentSpacing: 10,
  trailSpacing: 5, // distance between stored path points (segmentSpacing is a multiple)
  protectSeconds: 8, // nobody can die in the first seconds of a match (time to find the screen and the mouse)
  turnRate: (270 * Math.PI) / 180,
  boostSpeed: 1.7,
  boostCostPerSecond: 0.015,
  deathMass: 5,
  maxDeathOrbs: 80,
  /** Every so often a cluster of rich coins lands inside the safe zone and pulls everybody toward it. */
  airdropEveryS: 30,
  airdropOrbs: 6,
  airdropValue: 4,
} as const;

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
}

export type Role = "paid" | "saboteur";
export interface Orb {
  id: number;
  x: number;
  y: number;
  v: number;
}
export interface Player {
  w: string;
  n: string;
  role: Role;
  bot: boolean;
  alive: boolean;
  m: number;
  peak: number;
  x: number;
  y: number;
  heading: number;
  dx: number;
  dy: number;
  boost: boolean;
  /** Path of the head, newest first, one point every `trailSpacing` units. */
  trail: [number, number][];
  /** Seconds into the match until which the player cannot die. */
  protectUntil: number;
  /** Seconds into the match when it died; -1 while alive. */
  diedAt: number;
  killer: string;
}

export interface Death {
  w: string;
  by: string; // wallet, "zone" or "wall"
}
export interface StepResult {
  eatenOrbs: number[];
  newOrbs: Orb[];
  deaths: Death[];
}

// Sized like the .io snake games: a head is about 15 units wide at the start and moves about 9 radii per second.
export const bodyRadius = (m: number) => 10 + 1.1 * Math.sqrt(m);
export const speedOf = (m: number) => 135 / (1 + m / 600);
/** Turn rate in radians per second: a heavy body turns wider, but never becomes a slug (a log, not a hyperbola). */
export const turnRateOf = (m: number) => ARENA.turnRate / (1 + 0.35 * Math.log(1 + Math.max(0, m - ARENA.startMass) / 60));
export const segmentCount = (m: number) =>
  Math.max(6, Math.min(ARENA.maxBodySegments, 6 + Math.floor(m / 3)));

export interface Zone {
  cx: number;
  cy: number;
  r: number;
}

/** Radii of the safe zone phases: the start circle and five shrinks, the last one is the final circle. */
export const ZONE_RADII = [1450, 1050, 720, 460, 290, 150] as const;
export const ZONE_PHASES = ZONE_RADII.length - 1;
/** Each phase: the next circle is announced (warn), then the zone moves to it (shrink), then it holds. */
const WARN_FRAC = 0.2;
const SHRINK_FRAC = 0.35;

export interface ZonePlan {
  centers: { x: number; y: number }[]; // length ZONE_RADII.length, centers[0] is the arena center
  matchMs: number;
  shrinkStartMs: number;
}

/** Random, nested circles: every next circle lies completely inside the previous one but its center is somewhere else. */
export function buildZonePlan(rng: Rng, matchMs: number, shrinkStartMs: number): ZonePlan {
  const centers = [{ x: ARENA.w / 2, y: ARENA.h / 2 }];
  for (let i = 0; i < ZONE_PHASES; i++) {
    const room = ZONE_RADII[i] - ZONE_RADII[i + 1];
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(0.3, 0.92) * room;
    centers.push({ x: centers[i].x + Math.cos(ang) * dist, y: centers[i].y + Math.sin(ang) * dist });
  }
  return { centers, matchMs, shrinkStartMs };
}

export interface ZoneState extends Zone {
  /** 0 before the first announcement, 1..5 for the phases. */
  phase: number;
  state: "calm" | "warn" | "shrink" | "hold";
  /** Seconds until the state changes (0 when it never does). */
  inSeconds: number;
  /** The circle the zone is moving to, while it is announced or moving. */
  target: Zone | null;
}

/** The safe zone at time t (seconds). */
export function zoneState(t: number, plan: ZonePlan): ZoneState {
  const start = plan.shrinkStartMs / 1000;
  const span = plan.matchMs / 1000 - start;
  const L = span / ZONE_PHASES;
  const warn = L * WARN_FRAC;
  const shrink = L * SHRINK_FRAC;
  const c0 = plan.centers[0];
  if (t < start) {
    // The first target is announced a few seconds before the shrink begins.
    const lead = 5;
    const showing = t >= start - lead;
    return {
      cx: c0.x, cy: c0.y, r: ZONE_RADII[0], phase: 0, state: showing ? "warn" : "calm", inSeconds: start - t,
      target: showing ? { cx: plan.centers[1].x, cy: plan.centers[1].y, r: ZONE_RADII[1] } : null,
    };
  }
  const i = Math.min(ZONE_PHASES - 1, Math.floor((t - start) / L));
  const local = t - (start + i * L);
  const from = plan.centers[i];
  const to = plan.centers[i + 1];
  const r0 = ZONE_RADII[i];
  const r1 = ZONE_RADII[i + 1];
  const target = { cx: to.x, cy: to.y, r: r1 };
  if (local < warn) return { cx: from.x, cy: from.y, r: r0, phase: i + 1, state: "warn", inSeconds: warn - local, target };
  if (local < warn + shrink) {
    const f = (local - warn) / shrink;
    return {
      cx: from.x + (to.x - from.x) * f, cy: from.y + (to.y - from.y) * f, r: r0 + (r1 - r0) * f,
      phase: i + 1, state: "shrink", inSeconds: warn + shrink - local, target,
    };
  }
  const last = i === ZONE_PHASES - 1;
  return { cx: to.x, cy: to.y, r: r1, phase: i + 1, state: "hold", inSeconds: last ? 0 : L - local, target: null };
}

/** Outside the zone a player loses mass every second: 10 percent plus 3, harsher in later phases. */
export function zoneDamagePerSecond(mass: number, phase: number): number {
  return (mass * 0.1 + 3) * (1 + 0.3 * Math.max(0, phase - 1));
}

/** Body points of a player, head first, spaced `segmentSpacing` apart along its path. */
export function bodyPoints(p: Player): [number, number][] {
  const every = Math.round(ARENA.segmentSpacing / ARENA.trailSpacing);
  const n = segmentCount(p.m);
  const out: [number, number][] = [[p.x, p.y]];
  for (let k = 1; k <= n; k++) {
    const idx = k * every - 1;
    if (idx >= p.trail.length) break;
    out.push(p.trail[idx]);
  }
  return out;
}

export class Arena {
  readonly rng: Rng;
  readonly players: Player[] = [];
  orbs: Orb[] = [];
  time = 0; // seconds
  private nextOrbId = 1;
  readonly matchMs: number;
  readonly shrinkStartMs: number;
  readonly zonePlan: ZonePlan;
  /** Every change of steering or boost of every player, as [tick, player index, angle byte, boost]. This is the match record. */
  readonly inputLog: [number, number, number, number][] = [];
  private stepN = 0;
  private lastKey: number[] = [];

  constructor(
    seed: number,
    entrants: { w: string; n: string; role: Role; bot: boolean }[],
    opts: { matchMs?: number; shrinkStartMs?: number } = {},
  ) {
    this.matchMs = opts.matchMs ?? ARENA.matchMs;
    this.shrinkStartMs = opts.shrinkStartMs ?? ARENA.shrinkStartMs;
    this.rng = new Rng(seed);
    const cx = ARENA.w / 2;
    const cy = ARENA.h / 2;
    this.zonePlan = buildZonePlan(this.rng, this.matchMs, this.shrinkStartMs);
    entrants.forEach((e, i) => {
      // Spread the starts on a ring inside the zone, facing the center.
      const ang = (i / entrants.length) * Math.PI * 2 + this.rng.range(-0.1, 0.1);
      const rad = ARENA.zoneR0 * 0.6;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad;
      const heading = Math.atan2(cy - y, cx - x);
      // The body exists from the first tick: it lies straight behind the head, as if the player had been walking in a line.
      const back = ARENA.maxBodySegments * Math.round(ARENA.segmentSpacing / ARENA.trailSpacing) + 6;
      const trail: [number, number][] = [];
      for (let k = 1; k <= back; k++) {
        const tx = x - Math.cos(heading) * ARENA.trailSpacing * k;
        const ty = y - Math.sin(heading) * ARENA.trailSpacing * k;
        trail.push([Math.max(0, Math.min(ARENA.w, tx)), Math.max(0, Math.min(ARENA.h, ty))]);
      }
      this.players.push({
        w: e.w, n: e.n, role: e.role, bot: e.bot, alive: true,
        m: ARENA.startMass, peak: ARENA.startMass,
        x, y, heading, dx: Math.cos(heading), dy: Math.sin(heading), boost: false,
        trail, protectUntil: ARENA.protectSeconds, diedAt: -1, killer: "",
      });
    });
    while (this.orbs.length < ARENA.orbTarget) this.orbs.push(this.newOrb());
  }

  zoneNow(): ZoneState {
    return zoneState(this.time, this.zonePlan);
  }

  zone(): Zone {
    return this.zoneNow();
  }

  private nextDrop: number = ARENA.airdropEveryS;

  private newOrb(): Orb {
    // Uniform over the current safe zone, so loot always lies where people have to go.
    const z = this.zone();
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * (z.r - 30);
    const k = this.rng.next();
    const v = k < 0.7 ? ARENA.orbValues[0] : k < 0.93 ? ARENA.orbValues[1] : ARENA.orbValues[2];
    return { id: this.nextOrbId++, x: Math.round(z.cx + Math.cos(a) * r), y: Math.round(z.cy + Math.sin(a) * r), v };
  }

  player(w: string) {
    return this.players.find((p) => p.w === w);
  }

  setInput(w: string, dx: number, dy: number, boost: boolean) {
    const p = this.player(w);
    if (!p || !p.alive) return;
    let x = Number.isFinite(dx) ? dx : 0;
    let y = Number.isFinite(dy) ? dy : 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    if (len > 0) { p.dx = x; p.dy = y; }
    p.boost = !!boost;
  }

  aliveCount() {
    return this.players.filter((p) => p.alive).length;
  }

  private kill(p: Player, by: string, ev: StepResult) {
    if (!p.alive) return;
    p.alive = false;
    p.diedAt = this.time;
    p.killer = by;
    ev.deaths.push({ w: p.w, by });
    // 100% of the mass becomes orbs over the exact path of the body.
    const pts = bodyPoints(p);
    const count = Math.max(1, Math.min(ARENA.maxDeathOrbs, Math.floor(p.m)));
    const value = p.m / count;
    for (let i = 0; i < count; i++) {
      const [x, y] = pts[Math.min(pts.length - 1, Math.floor((i * pts.length) / count))];
      const o: Orb = { id: this.nextOrbId++, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, v: Math.round(value * 1000) / 1000 };
      this.orbs.push(o);
      ev.newOrbs.push(o);
    }
    p.m = 0;
    p.trail = [];
  }

  step(dt: number, brain?: (a: Arena, p: Player) => { dx: number; dy: number; boost: boolean }): StepResult {
    const ev: StepResult = { eatenOrbs: [], newOrbs: [], deaths: [] };
    this.time += dt;
    const zoneNow = this.zoneNow();
    const cx = zoneNow.cx;
    const cy = zoneNow.cy;
    const zr = zoneNow.r;

    // Move.
    const tickNo = this.stepN++;
    for (let pi = 0; pi < this.players.length; pi++) {
      const p = this.players[pi];
      if (!p.alive) continue;
      if (p.bot && brain) {
        const a = brain(this, p);
        p.dx = a.dx; p.dy = a.dy; p.boost = a.boost;
      }
      // The steering is quantized to 256 directions, so the match record (angle byte and boost) replays it exactly.
      const TAU = Math.PI * 2;
      const ab = Math.round((((Math.atan2(p.dy, p.dx) % TAU) + TAU) % TAU) / TAU * 256) & 255;
      const hd = (ab / 256) * TAU;
      p.dx = Math.cos(hd);
      p.dy = Math.sin(hd);
      const key = ab | (p.boost ? 256 : 0);
      if (this.lastKey[pi] !== key) {
        this.lastKey[pi] = key;
        this.inputLog.push([tickNo, pi, ab, p.boost ? 1 : 0]);
      }
      const want = Math.atan2(p.dy, p.dx);
      let diff = want - p.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Giant hunter: the heavier the body, the slower it turns, so a light player can out-maneuver a big one.
      const maxTurn = turnRateOf(p.m) * dt;
      p.heading += Math.max(-maxTurn, Math.min(maxTurn, diff));

      let speed = speedOf(p.m);
      if (p.boost && p.m > ARENA.minMass) {
        speed *= ARENA.boostSpeed;
        p.m = Math.max(ARENA.minMass, p.m - p.m * ARENA.boostCostPerSecond * dt);
      }
      const px = p.x, py = p.y;
      p.x += Math.cos(p.heading) * speed * dt;
      p.y += Math.sin(p.heading) * speed * dt;

      // Store the path: points are laid every trailSpacing units along the actual movement.
      const moved = Math.hypot(p.x - px, p.y - py);
      if (moved > 0) {
        const last = p.trail[0] ?? [px, py];
        let remain = Math.hypot(p.x - last[0], p.y - last[1]);
        if (remain >= ARENA.trailSpacing) {
          const n = Math.floor(remain / ARENA.trailSpacing);
          const ux = (p.x - last[0]) / remain;
          const uy = (p.y - last[1]) / remain;
          for (let i = 1; i <= n; i++) {
            p.trail.unshift([last[0] + ux * ARENA.trailSpacing * i, last[1] + uy * ARENA.trailSpacing * i]);
          }
          const keep = ARENA.maxBodySegments * Math.round(ARENA.segmentSpacing / ARENA.trailSpacing) + 6;
          if (p.trail.length > keep) p.trail.length = keep;
        }
      }
    }

    // The edge and the zone.
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.protectUntil > this.time) {
        // Protected: the edge cannot kill and the zone does not hurt yet; keep the head on the map.
        p.x = Math.max(0, Math.min(ARENA.w, p.x));
        p.y = Math.max(0, Math.min(ARENA.h, p.y));
        continue;
      }
      if (p.x < 0 || p.y < 0 || p.x > ARENA.w || p.y > ARENA.h) {
        this.kill(p, "wall", ev);
        continue;
      }
      if (Math.hypot(p.x - cx, p.y - cy) > zr) {
        p.m -= zoneDamagePerSecond(p.m, zoneNow.phase) * dt;
        if (p.m < ARENA.deathMass) this.kill(p, "zone", ev);
      }
    }

    // Orbs.
    for (const p of this.players) {
      if (!p.alive) continue;
      const r = bodyRadius(p.m) + 6;
      for (let i = this.orbs.length - 1; i >= 0; i--) {
        const o = this.orbs[i];
        const ddx = o.x - p.x;
        const ddy = o.y - p.y;
        if (Math.abs(ddx) <= r && Math.abs(ddy) <= r && ddx * ddx + ddy * ddy <= r * r) {
          p.m += o.v;
          if (p.m > p.peak) p.peak = p.m;
          ev.eatenOrbs.push(o.id);
          this.orbs.splice(i, 1);
        }
      }
    }

    // Collisions: a head that touches another player's solid body dies. Head against head: the lighter dies.
    const dying = new Map<string, string>();
    const bodies = new Map<string, [number, number][]>();
    for (const p of this.players) if (p.alive) bodies.set(p.w, bodyPoints(p));
    for (const a of this.players) {
      if (!a.alive || a.protectUntil > this.time) continue;
      const ra = bodyRadius(a.m);
      for (const b of this.players) {
        if (b === a || !b.alive) continue;
        // A protected player can neither be hurt nor hurt: the same rule in both directions.
        if (b.protectUntil > this.time) continue;
        const rb = bodyRadius(b.m);
        // Head against head decides alone (the body points next to a head must not turn a head-on into an unfair death):
        // the heavier survives, equal masses both die. Handled once per pair.
        const hx = a.x - b.x, hy = a.y - b.y;
        if (hx * hx + hy * hy < (ra + rb) * (ra + rb)) {
          if (a.w < b.w) {
            if (a.m < b.m) { if (!dying.has(a.w)) dying.set(a.w, b.w); }
            else if (b.m < a.m) { if (!dying.has(b.w)) dying.set(b.w, a.w); }
            else { if (!dying.has(a.w)) dying.set(a.w, b.w); if (!dying.has(b.w)) dying.set(b.w, a.w); }
          }
          continue;
        }
        const pts = bodies.get(b.w)!;
        // Skip the head point (index 0): head against head is handled above.
        for (let k = 1; k < pts.length; k++) {
          const ddx = a.x - pts[k][0];
          const ddy = a.y - pts[k][1];
          const lim = rb + ra * 0.35;
          if (ddx * ddx + ddy * ddy < lim * lim) {
            if (!dying.has(a.w)) dying.set(a.w, b.w);
            break;
          }
        }
      }
    }
    for (const [w, by] of dying) {
      const p = this.player(w);
      if (p) this.kill(p, by, ev);
    }

    // Airdrop: a cluster of rich coins somewhere inside the zone.
    if (this.time >= this.nextDrop) {
      this.nextDrop += ARENA.airdropEveryS;
      const z = this.zone();
      const a = this.rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(this.rng.next()) * Math.max(0, z.r - 160);
      const cx = z.cx + Math.cos(a) * rr, cy = z.cy + Math.sin(a) * rr;
      for (let i = 0; i < ARENA.airdropOrbs; i++) {
        const t = this.rng.range(0, Math.PI * 2), d = this.rng.range(0, 70);
        const o: Orb = { id: this.nextOrbId++, x: Math.round(cx + Math.cos(t) * d), y: Math.round(cy + Math.sin(t) * d), v: ARENA.airdropValue };
        this.orbs.push(o);
        ev.newOrbs.push(o);
      }
    }

    // Keep the map stocked.
    let mapOrbs = this.orbs.length;
    while (mapOrbs < ARENA.orbTarget) {
      const o = this.newOrb();
      this.orbs.push(o);
      ev.newOrbs.push(o);
      mapOrbs++;
    }
    return ev;
  }

  /** Alive players by mass, then dead players by time of death (later is better). Ties: lower wallet. */
  ranking(): { w: string; rank: number; score: number; role: Role }[] {
    const sorted = [...this.players].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.alive) return b.m - a.m || (a.w < b.w ? -1 : 1);
      return b.diedAt - a.diedAt || (a.w < b.w ? -1 : 1);
    });
    return sorted.map((p, i) => ({ w: p.w, rank: i + 1, score: Math.round(p.peak * 10) / 10, role: p.role }));
  }

  finished(): boolean {
    return this.time * 1000 >= this.matchMs || this.aliveCount() <= 1;
  }
}

/** A small bot for the devnet test mode: stay inside the zone, avoid bodies, eat orbs. */
export function arenaBrain(a: Arena, me: Player): { dx: number; dy: number; boost: boolean } {
  const zone = a.zone();
  const cx = zone.cx;
  const cy = zone.cy;
  const zr = zone.r;
  const dc = Math.hypot(me.x - cx, me.y - cy);
  const bodyR = bodyRadius(me.m);

  // Candidate headings; pick the safest, then the one nearest to an orb.
  let best = { score: -Infinity, dx: me.dx, dy: me.dy };
  for (let i = 0; i < 9; i++) {
    const ang = me.heading + ((i - 4) * Math.PI) / 8;
    const ahead = 70 + bodyR * 2;
    const tx = me.x + Math.cos(ang) * ahead;
    const ty = me.y + Math.sin(ang) * ahead;
    let score = 0;
    if (tx < 20 || ty < 20 || tx > ARENA.w - 20 || ty > ARENA.h - 20) score -= 1000;
    const dz = Math.hypot(tx - cx, ty - cy);
    if (dz > zr - 40) score -= 200 + (dz - (zr - 40));
    if (dc > zr - 150) score += 120 - Math.hypot(tx - cx, ty - cy) * 0.1; // drift inward when the zone closes
    for (const o of a.players) {
      if (o === me || !o.alive) continue;
      const pts = bodyPoints(o);
      for (let k = 0; k < pts.length; k += 2) {
        const d = Math.hypot(tx - pts[k][0], ty - pts[k][1]);
        const lim = bodyRadius(o.m) + bodyR + 25;
        if (d < lim) score -= 600 - d;
      }
    }
    let nearest = Infinity;
    for (const orb of a.orbs) {
      const d = Math.hypot(orb.x - tx, orb.y - ty);
      const w = d / (1 + orb.v);
      if (w < nearest) nearest = w;
    }
    score -= nearest * 0.4;
    score -= Math.abs(i - 4) * 2;
    if (score > best.score) best = { score, dx: Math.cos(ang), dy: Math.sin(ang) };
  }
  return { dx: best.dx, dy: best.dy, boost: false };
}
