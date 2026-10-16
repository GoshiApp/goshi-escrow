// Battle royale arena with solid bodies. Pure and deterministic: no network, no clock, no I/O.
// The rules are in server/PROTOCOL.md (section "Game rules").

/** A player whose connection drops is played by the bot and cannot be hurt for this long. It is part of the match record. */
export const AWAY_PROTECT_S = 20;
/** While the bot plays a body for a player who is not there, the body does not eat and loses this share of its mass per second. */
export const AWAY_DRAIN_PER_S = 0.03;
/** When they come back they get this long to find their body and steer. */
export const BACK_PROTECT_S = 5;
/** How many times a player may drop and be covered in one match (a flapping connection must not be a shield). */
export const MAX_AWAYS = 2;

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
  /** True for the orbs a body leaves when it dies: the bots go for them first. */
  loot?: boolean;
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
  /** The person asked the computer to play their body (an elite bot) while they are away from the keyboard. */
  afk?: boolean;
  /** The team's own verified wallet in the live arena: it eats other bodies instead of dying on them. */
  ceo?: boolean;
  /** True while the bot plays this body because the person's connection dropped. */
  auto?: boolean;
  /** How many times this player was covered after a dropped connection. */
  aways?: number;
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
/**
 * The rules of the arena come in versions, and a match record says which one it was played with:
 *  1: the first version (a big body is slow and looks small).
 *  2: a body grows in proportion (its radius follows the square root of its mass, so it looks as big as it is), a heavy body is
 *     only a little slower than a light one, a body three times heavier than another is not killed by its body but eats it
 *     bit by bit, and the more a body weighs, the richer the orbs it leaves when it dies.
 * `setRules` selects the version the next calls use; an Arena sets its own at every step, so a record is always played with the
 * rules it was recorded with.
 */
export type RulesVersion = 1 | 2;
export const RULES_NOW: RulesVersion = 2;
let activeRules: RulesVersion = RULES_NOW;
export const setRules = (v: RulesVersion): void => { activeRules = v; };
export const rulesActive = (): RulesVersion => activeRules;
export const bodyRadius = (m: number) => (activeRules === 1 ? 10 + 1.1 * Math.sqrt(m) : 8 + 1.9 * Math.sqrt(m));
export const speedOf = (m: number) => (activeRules === 1 ? 135 / (1 + m / 600) : 135 / (1 + m / 2500));
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
  /** The version of the rules this match is played with (written in its record). */
  readonly rules: RulesVersion;
  /** Survival: an arena that never ends. Bodies that die come back after a few seconds (bots), the zone never closes. */
  readonly survival: boolean;
  /** Survival show: bots come back together, once this many are down (0: each one on its own after 3 seconds). */
  readonly respawnBatch: number;
  readonly shrinkStartMs: number;
  readonly zonePlan: ZonePlan;
  /** Every change of steering or boost of every player, as [tick, player index, angle byte, boost]. This is the match record. */
  readonly inputLog: [number, number, number, number][] = [];
  private stepN = 0;
  private lastKey: number[] = [];

  constructor(
    seed: number,
    entrants: { w: string; n: string; role: Role; bot: boolean }[],
    opts: { matchMs?: number; shrinkStartMs?: number; survival?: boolean; respawnBatch?: number; rules?: RulesVersion } = {},
  ) {
    this.rules = opts.rules ?? RULES_NOW;
    setRules(this.rules);
    this.survival = opts.survival === true;
    this.respawnBatch = opts.respawnBatch ?? 0;
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
    while (this.orbs.length < this.foodTarget()) this.orbs.push(this.newOrb());
  }

  /** How many orbs the map holds: survival keeps it richer, because nobody leaves it to rest. */
  private foodTarget(): number {
    return this.survival ? 900 : ARENA.orbTarget;
  }

  zoneNow(): ZoneState {
    return zoneState(this.time, this.zonePlan);
  }

  zone(): Zone {
    return this.zoneNow();
  }

  private nextDrop: number = ARENA.airdropEveryS;
  /** When the last airdrop landed (and where): the snapshot of that moment says so, so the page can announce it. */
  dropAt: { x: number; y: number; t: number } | null = null;
  /** Seconds to the next airdrop. */
  nextDropIn(): number { return Math.max(0, this.nextDrop - this.time); }

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
    if (!p || !p.alive || p.auto || p.afk) return;
    let x = Number.isFinite(dx) ? dx : 0;
    let y = Number.isFinite(dy) ? dy : 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    if (len > 0) { p.dx = x; p.dy = y; }
    p.boost = !!boost;
  }

  private pendingAway: { w: string; back: boolean }[] = [];
  /** The person's connection dropped: the bot plays the body and nothing can hurt it for AWAY_PROTECT_S. Limited per match.
   *  It takes effect at the next step and is written in the match record (flag 2), so the match still replays exactly. */
  away(w: string): boolean {
    const p = this.player(w);
    if (!p || !p.alive || p.auto || (p.aways ?? 0) >= MAX_AWAYS) return false;
    p.aways = (p.aways ?? 0) + 1;
    p.auto = true;
    this.pendingAway.push({ w, back: false });
    return true;
  }
  /** The person is back: they steer again and have BACK_PROTECT_S to find their body (flag 3 in the record). */
  back(w: string): boolean {
    const p = this.player(w);
    if (!p || !p.alive || !p.auto) return false;
    p.auto = false;
    this.pendingAway.push({ w, back: true });
    return true;
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
    // Version 2: a big body leaves richer orbs (up to half as much again), so beating a giant is worth the trouble.
    const value = (p.m / count) * (this.rules >= 2 ? 1 + Math.min(0.5, p.m / 6000) : 1);
    for (let i = 0; i < count; i++) {
      const [x, y] = pts[Math.min(pts.length - 1, Math.floor((i * pts.length) / count))];
      const o: Orb = { id: this.nextOrbId++, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, v: Math.round(value * 1000) / 1000, loot: true };
      this.orbs.push(o);
      ev.newOrbs.push(o);
    }
    p.m = 0;
    p.trail = [];
  }

  step(dt: number, brain?: (a: Arena, p: Player) => { dx: number; dy: number; boost: boolean }): StepResult {
    const ev: StepResult = { eatenOrbs: [], newOrbs: [], deaths: [] };
    setRules(this.rules);
    for (const q of this.pendingAway.splice(0)) {
      const pi = this.players.findIndex((x) => x.w === q.w);
      if (pi < 0) continue;
      const secs = q.back ? BACK_PROTECT_S : AWAY_PROTECT_S;
      this.players[pi].protectUntil = Math.max(this.players[pi].protectUntil, this.time + secs);
      if (!this.survival) this.inputLog.push([this.stepN, pi, 0, q.back ? 3 : 2]);
    }
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
      if ((p.bot || p.auto || p.afk) && brain) {
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
        if (!this.survival) this.inputLog.push([tickNo, pi, ab, p.boost ? 1 : 0]);
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

    // A body that is played by the bot because its person is not there is shielded for a short time, but it shrinks and eats
    // nothing: dropping the connection is never a way to keep a body alive for free.
    for (const p of this.players) {
      if (p.alive && p.auto && p.m > ARENA.minMass) p.m = Math.max(ARENA.minMass, p.m * (1 - AWAY_DRAIN_PER_S * dt));
    }

    // Orbs.
    for (const p of this.players) {
      if (!p.alive || p.auto) continue;
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
            // Survival: a body at least three times heavier (and the team's own) is not killed by a small one's body: it eats
            // a bite of it, which is mass for the big one and a shorter body for the small one.
            if (this.rules >= 2 && (a.ceo || a.m >= b.m * 3)) {
              const bite = Math.max(0.4, b.m * 0.04);
              b.m -= bite;
              a.m += bite;
              if (a.m > a.peak) a.peak = a.m;
              if (b.m < ARENA.deathMass && !dying.has(b.w)) dying.set(b.w, a.w);
              break;
            }
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
      this.nextDrop += this.survival ? 12 : ARENA.airdropEveryS;
      this.dropAt = { x: 0, y: 0, t: this.time };
      const z = this.zone();
      const a = this.rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(this.rng.next()) * Math.max(0, z.r - 160);
      const cx = z.cx + Math.cos(a) * rr, cy = z.cy + Math.sin(a) * rr;
      if (this.dropAt) { this.dropAt.x = Math.round(cx); this.dropAt.y = Math.round(cy); }
      for (let i = 0; i < (this.survival ? 9 : ARENA.airdropOrbs); i++) {
        const t = this.rng.range(0, Math.PI * 2), d = this.rng.range(0, 70);
        const o: Orb = { id: this.nextOrbId++, x: Math.round(cx + Math.cos(t) * d), y: Math.round(cy + Math.sin(t) * d), v: ARENA.airdropValue };
        this.orbs.push(o);
        ev.newOrbs.push(o);
      }
    }

    // Keep the map stocked.
    let mapOrbs = this.orbs.length;
    while (mapOrbs < this.foodTarget()) {
      const o = this.newOrb();
      this.orbs.push(o);
      ev.newOrbs.push(o);
      mapOrbs++;
    }
    if (this.survival) this.respawnBots();
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

  /** Survival: a dead bot comes back at a spot on a ring inside the zone, small and protected for a moment. */
  private respawnBots(): void {
    if (this.respawnBatch > 0) {
      let down = 0;
      for (const p of this.players) if (!p.alive && p.bot && p.diedAt >= 0) down++;
      if (down < this.respawnBatch) return;
    }
    for (const p of this.players) {
      if (p.alive || !p.bot || p.diedAt < 0 || this.time - p.diedAt < 3) continue;
      this.placeSafely(p, 4);
    }
  }

  /** Puts a body back in the arena, small, protected for a moment, on the spot (out of a dozen tried) farthest from every body. */
  private placeSafely(p: Player, protectS: number): void {
    const cx = ARENA.w / 2, cy = ARENA.h / 2;
    let x = cx, y = cy, clear = -1;
    for (let tries = 0; tries < 12; tries++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const rad = ARENA.zoneR0 * (0.25 + 0.6 * this.rng.next());
      const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad;
      let nearest = Infinity;
      for (const o of this.players) {
        if (o === p || !o.alive) continue;
        for (const pt of bodyPoints(o)) { const d = Math.hypot(px - pt[0], py - pt[1]); if (d < nearest) nearest = d; }
      }
      if (nearest > clear) { clear = nearest; x = px; y = py; }
    }
    const heading = Math.atan2(cy - y, cx - x);
    const back = ARENA.maxBodySegments * Math.round(ARENA.segmentSpacing / ARENA.trailSpacing) + 6;
    const trail: [number, number][] = [];
    for (let k = 1; k <= back; k++) {
      trail.push([Math.max(0, Math.min(ARENA.w, x - Math.cos(heading) * ARENA.trailSpacing * k)), Math.max(0, Math.min(ARENA.h, y - Math.sin(heading) * ARENA.trailSpacing * k))]);
    }
    p.alive = true; p.m = ARENA.startMass; p.peak = ARENA.startMass;
    p.x = x; p.y = y; p.heading = heading; p.dx = Math.cos(heading); p.dy = Math.sin(heading); p.boost = false;
    p.trail = trail; p.protectUntil = this.time + protectS; p.diedAt = -1; p.killer = "";
  }

  /** The person hands the body to the elite bot, or takes it back. */
  setAfk(w: string, on: boolean): boolean {
    const p = this.player(w);
    if (!p || p.bot) return false;
    p.afk = on;
    return true;
  }

  /** Survival with a live audience: a person takes over a slot (a bot's body until now) and starts small and protected. */
  claim(p: Player, w: string, n: string): void {
    p.w = w;
    p.n = n;
    p.bot = false;
    p.auto = false;
    this.placeSafely(p, 8);
  }

  /** The slot goes back to a bot with its own fixed address; if the body is dead the bot comes back on its own. */
  release(p: Player, w: string, n: string): void {
    p.w = w;
    p.n = n;
    p.bot = true;
    p.auto = false;
  }


  finished(): boolean {
    if (this.survival) return false;
    return this.time * 1000 >= this.matchMs || this.aliveCount() <= 1;
  }
}

/** A small bot for the devnet test mode: stay inside the zone, avoid bodies, eat orbs. */
/** What a bot remembers between ticks: the orb it is going for and the heading it was steering. A bot that decides again every
 *  tick wobbles like a worm in a jar; one that commits to a target, turns at a human rate and only changes its mind for danger
 *  moves like a player. Kept outside the Player so the record and the snapshots are untouched. */
const brainMem = new WeakMap<Player, { orb: number; until: number; ang: number; side: number; d0: number; t0: number; ban: Map<number, number>; prey: string; preyUntil: number; circDir: number; encT: number }>();

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export type Difficulty = "easy" | "medium" | "hard" | "insane";
interface BotLevel { turn: number; hunt: number; huntRange: number; avoid: number; look2: boolean; wobble: number; boost: boolean; chase: boolean; encircle: boolean; herd: boolean; win: boolean; loot: number; orbRange: number }
/** How good the bots are: how fast they steer, how many of them hunt, how far they see and whether they use the boost. */
const LEVELS: Readonly<Record<Difficulty, BotLevel>> = {
  easy: { turn: 0.45, hunt: 0, huntRange: 0, avoid: 0.6, look2: false, wobble: 0.35, boost: false, chase: false, encircle: false, herd: false, win: false, loot: 1.6, orbRange: 420 },
  medium: { turn: 0.7, hunt: 0.34, huntRange: 380, avoid: 0.85, look2: true, wobble: 0.12, boost: false, chase: false, encircle: false, herd: false, win: false, loot: 2.6, orbRange: 600 },
  hard: { turn: 0.85, hunt: 0.67, huntRange: 480, avoid: 1, look2: true, wobble: 0, boost: true, chase: false, encircle: false, herd: true, win: true, loot: 3.6, orbRange: 700 },
  insane: { turn: 1, hunt: 1, huntRange: 760, avoid: 1.25, look2: true, wobble: 0, boost: true, chase: true, encircle: true, herd: true, win: true, loot: 4.6, orbRange: 900 },
};
const levelOf = new WeakMap<Arena, Difficulty>();
/** Set once, for a practice match: its bots play at that level. Rooms with money keep the default (hard). */
export function setBotDifficulty(a: Arena, d: Difficulty): void { levelOf.set(a, d); }
export const isDifficulty = (v: unknown): v is Difficulty => v === "easy" || v === "medium" || v === "hard" || v === "insane";

export function arenaBrain(a: Arena, me: Player): { dx: number; dy: number; boost: boolean } {
  setRules(a.rules);
  let st = brainMem.get(me);
  if (!st) { st = { orb: -1, until: 0, ang: me.heading, side: 0, d0: 0, t0: 0, ban: new Map(), prey: "", preyUntil: 0, circDir: 1, encT: 0 }; brainMem.set(me, st); }
  // A body played for its person (AFK) plays like the best bot there is.
  const P = LEVELS[me.afk ? "insane" : levelOf.get(a) ?? "hard"];
  const zone = a.zone();
  const cx = zone.cx, cy = zone.cy, zr = zone.r;
  const bodyR = bodyRadius(me.m);
  const dc = Math.hypot(me.x - cx, me.y - cy);

  // The others: head and body points once per call.
  const others: { w: string; pts: [number, number][]; r: number; heavier: boolean; hx: number; hy: number; prot: boolean; hd: number; m: number }[] = [];
  for (const o of a.players) {
    if (o === me || !o.alive) continue;
    others.push({ w: o.w, hd: o.heading, m: o.m, pts: bodyPoints(o).filter((_, k) => k % 2 === 0), r: bodyRadius(o.m), heavier: o.m > me.m * 0.95, hx: o.x, hy: o.y, prot: o.protectUntil > a.time });
  }

  // Where it wants to go: back inside when the zone is close, else the best orb it has committed to.
  let want = st.ang;
  const nearEdge = dc > zr - 120;
  if (nearEdge) {
    want = Math.atan2(cy - me.y, cx - me.x);
    st.orb = -1;
  } else {
    let target = a.orbs.find((o) => o.id === st!.orb);
    // An orb it keeps circling without getting closer (inside its turning circle) is dropped for a while.
    if (target) {
      const dT = Math.hypot(target.x - me.x, target.y - me.y);
      if (a.time - st.t0 > 1.2 && dT > st.d0 * 0.6 && dT < 140) { st.ban.set(target.id, a.time + 5); target = undefined; st.orb = -1; }
    }
    if (!target || a.time > st.until) {
      let bestScore = -Infinity;
      target = undefined;
      for (const o of a.orbs) {
        const d = Math.hypot(o.x - me.x, o.y - me.y);
        if (d > (o.loot ? P.orbRange * 1.4 : P.orbRange)) continue;
        if ((st.ban.get(o.id) ?? 0) > a.time) continue;
        const turn = Math.abs(angDiff(Math.atan2(o.y - me.y, o.x - me.x), st.ang));
        // What a body left behind is worth more than its mass: it is free food, and somebody else is going for it.
        // A pile of food in the middle of three bigger bodies is not worth it: the more dangerous heads near an orb, the less it is worth.
        let risk = 0;
        for (const q of others) { if (q.heavier && Math.hypot(q.hx - o.x, q.hy - o.y) < 260) risk++; }
        const sc = (1 + o.v * (o.loot ? P.loot : 1)) / ((d + 60) * (1 + 0.9 * risk)) - turn * 0.0009;
        if (sc > bestScore) { bestScore = sc; target = o; }
      }
      if (target) { st.orb = target.id; st.until = a.time + 1.6 + ((target.id * 31) % 7) * 0.1; st.d0 = Math.hypot(target.x - me.x, target.y - me.y); st.t0 = a.time; }
    }
    want = target ? Math.atan2(target.y - me.y, target.x - me.x) : Math.atan2(cy - me.y, cx - me.x) + (st.side || 1) * 0.6;
    if (P.wobble > 0) want += Math.sin(a.time * 1.7 + me.x * 0.01) * P.wobble;
  }

  // Hunting: a body clearly heavier than another one goes for its head (head against head, the heavier survives) and the
  // lighter ones it meets are chased instead of ignored. Only some bots are hunters, so a room does not turn into a pack.
  let preyW = "";
  let chasing = false;
  // Playing to win: with few left and the lead in hand, a bot stops looking for fights and keeps to the middle of the zone.
  let aliveN = 0, topMass = 0;
  for (const o of a.players) if (o.alive) { aliveN++; if (o.m > topMass) topMass = o.m; }
  const leading = P.win && aliveN <= 4 && me.m >= topMass * 0.98;
  if (leading && !nearEdge) {
    const home = Math.atan2(cy - me.y, cx - me.x);
    if (dc > zr * 0.55) want = home;
  }
  if (!leading && !nearEdge && P.hunt > 0 && me.m > 30 && ((me.w.charCodeAt(me.w.length - 1) + me.w.charCodeAt(0)) % 100) / 100 < P.hunt) {
    let best: (typeof others)[number] | undefined, bestD = P.huntRange;
    for (const o of others) {
      if (o.prot || o.m * 1.15 > me.m) continue;
      const dd = Math.hypot(o.hx - me.x, o.hy - me.y);
      if (dd < bestD) { bestD = dd; best = o; }
    }
    if (best) {
      const lead = Math.min(0.6, bestD / 400);
      want = Math.atan2(best.hy + Math.sin(best.hd) * speedOf(best.m) * lead - me.y, best.hx + Math.cos(best.hd) * speedOf(best.m) * lead - me.x);
      preyW = best.w;
      chasing = bestD < 320;
      // Hard and super hard: a smaller body near the edge of the safe zone is herded outward. The bot gets on the inner side of
      // it and pushes outward, so the zone does the rest.
      if (P.herd && best.m * 1.15 < me.m && bestD < 420) {
        const pd = Math.hypot(best.hx - cx, best.hy - cy);
        if (pd > zr * 0.55 && pd < zr + 80) {
          const ox = (best.hx - cx) / (pd || 1), oy = (best.hy - cy) / (pd || 1);
          const side = (me.x - best.hx) * ox + (me.y - best.hy) * oy; // negative: the bot is on the inner side
          if (side < -20) want = Math.atan2(oy, ox);
          else want = Math.atan2(best.hy - oy * 150 - me.y, best.hx - ox * 150 - me.x);
          chasing = false;
        }
      }
      // Super hard: against a clearly smaller body, do not just chase the head: run around it on a circle that keeps getting
      // smaller (a spiral in), so the body closes a ring around it, and the ring tightens until it has nowhere to go.
      if (P.encircle && best.m * 1.35 < me.m && bestD < 520 && me.m > 60) {
        if (st.prey !== best.w || a.time - st.encT > 40) {
          st.prey = best.w;
          st.encT = a.time;
          st.circDir = angDiff(Math.atan2(best.hy - me.y, best.hx - me.x), me.heading) >= 0 ? 1 : -1;
        }
        const radial = Math.atan2(me.y - best.hy, me.x - best.hx);
        const R = Math.max(80, 230 - (a.time - st.encT) * 14);
        const inward = Math.max(-0.6, Math.min(1.2, (bestD - R) / R)) * (Math.PI / 2) * 0.8;
        want = radial + st.circDir * (Math.PI / 2) + st.circDir * inward;
        chasing = bestD > R * 1.8;
      }
    }
  }

  // Candidate headings in front of the body: cost of danger (walls, zone, bodies) plus how far from the wish and from the
  // current heading (so a small gain never makes it zig-zag).
  let bestAng = st.ang, bestCost = Infinity, fleeThreat = 0;
  for (let k = -7; k <= 7; k++) {
    const ang = st.ang + (k * Math.PI) / 14;
    let cost = 0;
    for (const reach of P.look2 ? [70 + bodyR * 2, 170 + bodyR * 3] : [70 + bodyR * 2]) {
      const tx = me.x + Math.cos(ang) * reach, ty = me.y + Math.sin(ang) * reach;
      const w = reach < 100 ? 1 : 0.5;
      if (tx < 30 || ty < 30 || tx > ARENA.w - 30 || ty > ARENA.h - 30) cost += 900 * w;
      const dz = Math.hypot(tx - cx, ty - cy);
      if (dz > zr - 30) cost += (240 + (dz - (zr - 30))) * w;
      for (const o of others) {
        const lim = o.r + bodyR + (o.heavier ? 38 : 22);
        // Its head is the dangerous part: a body segment only hurts if it is crossed, a head can come at you.
        const dh = Math.hypot(tx - o.hx, ty - o.hy);
        if (dh < lim + 20 && o.w !== preyW) { cost += (o.heavier ? 800 : 250) * w; if (o.heavier && reach < 100) fleeThreat = Math.max(fleeThreat, 1 - dh / (lim + 20)); }
        for (const pt of o.pts) {
          const d = Math.hypot(tx - pt[0], ty - pt[1]);
          if (d < o.r + bodyR + 16) cost += 700 * w;
        }
      }
    }
    cost *= P.avoid;
    cost += Math.abs(angDiff(ang, want)) * 70;
    cost += Math.abs(k) * 14;
    if (cost < bestCost) { bestCost = cost; bestAng = ang; }
  }

  // Turn at a human rate towards the chosen heading.
  const step = (turnRateOf(me.m) / ARENA.tickRate) * P.turn;
  const d = angDiff(bestAng, st.ang);
  st.ang += Math.max(-step, Math.min(step, d));
  if (Math.abs(d) > 0.05) st.side = d > 0 ? 1 : -1;
  // A burst only to get away from a heavier head that is on top of it, and only with mass to spare.
  const boost = P.boost && me.m > 40 && (fleeThreat > 0.35 || (P.chase && chasing && me.m > 70));
  return { dx: Math.cos(st.ang), dy: Math.sin(st.ang), boost };
}
