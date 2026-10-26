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
  /** Rules 5, a room paid by bag: the lamports this coin is worth (the pot is minted into coins). */
  l?: number;
  /** True for the orbs a body leaves when it dies: the bots go for them first. */
  loot?: boolean;
  /** Survival: 1 or 2 for the big coins that only big bodies can eat (see canEatOrb). */
  tier?: number;
  /** Survival: the coin it is (BTC, ETH, DOGE...) and how much of it; its mass is what that amount is worth in dollars. */
  c?: string;
  q?: number;
}

/** Survival coins: one unit of mass is worth this many dollars, at the prices taken when the arena started. */
export const USD_PER_MASS = 0.01;
/** Which coins fall, and how often (the meme and small chains more, BTC rarer). */
const COIN_MIX: readonly [string, number][] = [["DOGE", 30], ["SOL", 22], ["AVAX", 14], ["BNB", 12], ["ETH", 12], ["BTC", 10]];

/** Survival coins by size: the smallest mass that can eat each tier, and the value of a big coin. */
export const ORB_TIER_MIN = [0, 1500, 10_000] as const;
export const ORB_TIER_VALUE = [0, 40, 300] as const;
/** A body this heavy no longer eats the small coins (it is too big for them); loot and big coins are always worth it. */
export const ORB_SMALL_MAX = 6000;
export function canEatOrb(m: number, o: Orb): boolean {
  // A coin that carries SOL is money: anybody may eat it, whatever its size.
  if (o.loot || o.l) return true;
  const t = o.tier ?? 0;
  if (t === 0) return m < ORB_SMALL_MAX;
  return m >= ORB_TIER_MIN[t];
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
  /** Survival: extra length bought with SOL (0 to 0.2, that is up to 20 percent longer). */
  lengthBonus?: number;
  /** The team's own verified wallet in the live arena: it eats other bodies instead of dying on them. */
  ceo?: boolean;
  /** True while the bot plays this body because the person's connection dropped. */
  auto?: boolean;
  /** How many times this player was covered after a dropped connection. */
  aways?: number;
  /** Seconds into the match when it died; -1 while alive. */
  diedAt: number;
  killer: string;
  /** Cash arena (test): the lamports this person entered with, and how many players with an entry at least as big it eliminated. */
  entry?: number;
  qk?: number;
  /** Cash arena: the bag it took out when it cashed out (lamports). */
  cashedBag?: number;
  /** Cash arena: SOL taken from the bag by the current boost, popped out as a coin when the boost stops (lamports). */
  boostSpill?: number;
  /** Rules 6: the shield of the boss lasts until this time, and can be raised again from shieldReady. */
  shieldUntil?: number;
  shieldReady?: number;
  /** Rules 6: when the body started to cash out (it leaves the arena CASHOUT_S later if still alive), and what it took out. */
  cashoutAt?: number;
  /** Cash arena: the bag when the cash out began (it flows out evenly from there). */
  cashBag0?: number;
  /** Cash arena: the mass when the cash out began (it shrinks from there to nothing). */
  cashMass0?: number;
  banked?: number;
  /** Rules 5, a room paid by bag: the lamports of the coins this body carries. */
  bag?: number;
}

export interface Death {
  w: string;
  by: string; // wallet, "zone" or "wall"
}
export interface StepResult {
  eatenOrbs: number[];
  newOrbs: Orb[];
  deaths: Death[];
  /** Cash arena: the cut of a bag a killer took on the spot. */
  killCuts?: { w: string; from: string; l: number }[];
  /** Cash arena: SOL coins that just fused, as [from x, from y, into x, into y] (the page draws the link and the fusion). */
  fuses?: [number, number, number, number][];
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
export type RulesVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/**
 * Rules 8: the pot is not cut in equal coins. Each coin gets a weight from a fixed sequence (many small, some middling, a few
 * big ones, up to thirteen times the smallest) and its share of the lamports follows the weight; the remainder of the integer
 * division goes to the heaviest one, so the sum is exact. Returns the shares and the weights.
 */
export function unevenSplit(total: number, n: number, salt: number): { parts: number[]; weights: number[] } {
  const weights: number[] = [];
  for (let k = 0; k < n; k++) { const f = ((k + salt) * 0.6180339887498949) % 1; weights.push(0.15 + f * 0.6 + f * f * f * 2.5); }
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let big = 0;
  for (let k = 1; k < n; k++) if (weights[k] > weights[big]) big = k;
  parts[big] += total - parts.reduce((a, b) => a + b, 0);
  return { parts, weights };
}
/** Rules 7: when three bodies are left, the zone holds still this long so they can gather the coins lying around. */
export const FINAL3_FREEZE_S = 10;
export const RULES_NOW: RulesVersion = 3;
let activeRules: RulesVersion = RULES_NOW;
/**
 * Rules 4 (the test network first): nothing left to chance but where a dead body's coins land. The zone closes on the center,
 * the coins and the showers fall on a fixed public pattern (a golden-angle spiral), the starts are an exact ring. A new arena
 * uses the default set here; a record keeps the version it was played with.
 */
let defaultRules: RulesVersion = RULES_NOW;
export const setDefaultRules = (v: RulesVersion): void => { defaultRules = v; };
/** The golden angle and the fractional part of n times the golden ratio: an even, fixed spread with no randomness. */
const goldenFrac = (n: number) => (n * 0.6180339887498949) % 1;
/**
 * An even, fixed spread over a disc with no randomness: the R2 sequence (two unrelated irrational steps), so the angle and the
 * distance of point n never follow each other. (The golden angle with the golden fraction as distance are the same number in
 * disguise and lay every point on one spiral line.) Returns the angle in radians and the distance as a share of the radius.
 */
const R2A = 0.7548776662466927, R2B = 0.5698402909980532;
const spread = (n: number): [number, number] => [((0.5 + n * R2A) % 1) * Math.PI * 2, Math.sqrt((0.5 + n * R2B) % 1)];
export const setRules = (v: RulesVersion): void => { activeRules = v; };
export const rulesActive = (): RulesVersion => activeRules;
/** Radius of a body. Rules 8: past a mass of 200 it widens more slowly, so a giant (the boss) does not fill the map. */
export const bodyRadius = (m: number) => (activeRules === 1 ? 10 + 1.1 * Math.sqrt(m) : activeRules >= 8 && m > 200 ? 34.87 + (Math.sqrt(m) - 14.142) : 8 + 1.9 * Math.sqrt(m));
export const speedOf = (m: number) =>
  activeRules === 1 ? 135 / (1 + m / 600) : activeRules === 2 ? 135 / (1 + m / 2500) : 135 / (1 + 0.18 * Math.log(1 + Math.max(0, m) / 100));
/** Distance between two body points. Rules 3: a body heavier than 432 keeps getting longer (a quarter power of its mass). */
export const segmentSpacingOf = (m: number) =>
  activeRules >= 3 && m > 432 ? Math.min(lengthCap ? MAX_SPACING : Infinity, ARENA.segmentSpacing * Math.pow(m / 432, 0.25)) : ARENA.segmentSpacing;
/** Survival has no length limit: its arena sets this off at every step (a timed match keeps the cap, its records rely on it). */
let lengthCap = true;
export const setLengthCap = (on: boolean): void => { lengthCap = on; };
const MAX_SPACING = 40;
/** Boost cost per second, as a share of the mass. Rules 3: cheaper, so a big body can still catch somebody. */
export const boostCostOf = () => (activeRules >= 3 ? 0.006 : ARENA.boostCostPerSecond);
/** Path points kept behind a head: enough for the longest body of the rules in use. */
export const trailKeep = () => Math.round((ARENA.maxBodySegments * (activeRules >= 3 ? MAX_SPACING : ARENA.segmentSpacing)) / ARENA.trailSpacing) + 6;
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
export function buildZonePlan(rng: Rng, matchMs: number, shrinkStartMs: number, fixed = false): ZonePlan {
  const centers = [{ x: ARENA.w / 2, y: ARENA.h / 2 }];
  // Rules 4: every circle closes on the center, the same in every match.
  if (fixed) { for (let i = 0; i < ZONE_PHASES; i++) centers.push({ ...centers[0] }); return { centers, matchMs, shrinkStartMs }; }
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
  const step = (segmentSpacingOf(p.m) * (1 + (p.lengthBonus ?? 0))) / ARENA.trailSpacing;
  const n = segmentCount(p.m);
  const out: [number, number][] = [[p.x, p.y]];
  for (let k = 1; k <= n; k++) {
    const idx = Math.round(k * step) - 1;
    if (idx >= p.trail.length) break;
    out.push(p.trail[idx]);
  }
  return out;
}

/** Survival map: it starts at the zone radius and grows with the square root of the leader's mass from this mass on. */
const MAP_GROW_FROM = 1500;
const MAP_R_MAX = 30_000;
const MAP_GROW_PER_S = 160;
const MAP_SHRINK_PER_S = 45;

export const TRAP_LASER = 1;
export const TRAP_SLOW = 2;
export type TrapKind = typeof TRAP_LASER | typeof TRAP_SLOW | typeof POWER_KAMIKAZE | typeof POWER_SHIELD | typeof POWER_CASHOUT;
/**
 * Rules 6, the boss: the heaviest body alive, when it weighs at least BOSS_MIN_MASS and twice the next one. Every BOSS_CYCLE_S
 * seconds it is announced (BOSS_WARN_S ahead) and then exposed for BOSS_OPEN_S: its tail (the last quarter of its body) can be bitten by any
 * head without dying, each bite takes BOSS_BITE of its mass (half to the biter, half on the floor with the same share of its bag).
 * Against it: the kamikaze (a body near it blows up and takes up to KAMIKAZE_TAKE of its mass, the kamikaze dies). Its answer:
 * the shield (no bites and no kamikaze for SHIELD_S, once every SHIELD_CD_S, costs SHIELD_COST of its mass).
 * Cash out: a body channels CASHOUT_S at half speed; if it is still alive it leaves the arena with what it carries.
 */
export const POWER_KAMIKAZE = 3;
export const POWER_SHIELD = 4;
export const POWER_CASHOUT = 5;
export const BOSS_MIN_MASS = 300;
export const BOSS_LEAD = 2;
export const BOSS_CYCLE_S = 30;
export const BOSS_WARN_S = 5;
export const BOSS_OPEN_S = 4;
export const BOSS_BITE = 0.01;
export const KAMIKAZE_R = 320;
/** Rules 6: only the last quarter of the boss (its tail) is exposed. */
export const BOSS_TAIL = 0.75;
export const KAMIKAZE_TAKE = 0.15;
export const SHIELD_S = 4;
export const SHIELD_CD_S = 25;
export const SHIELD_COST = 0.05;
export const CASHOUT_S = 5;
/** Cash arena: the most SOL coins the map holds; past it the smallest fuse into their nearest (nothing is lost). */
export const CASH_COIN_CAP = 140;
/** Cash arena: the share of a victim's bag that goes straight to whoever eliminated it. */
export const CASH_KILL_CUT = 0.15;
/** Cash arena: eliminations needed to cash out, and the entry a bot counts as (lamports). */
export const CASH_KILLS = 3;
export const CASH_MIN_ENTRY = 3_000_000;
/** Cash arena: mass per lamport of a coin (20 000 mass per SOL, so a 0.003 SOL entry is 60 mass on the map). */
export const CASH_MASS_PER_LAMPORT = 20_000 / 1e9;
export const TRAP_LASER_S = 3;
export const TRAP_LASER_HALF = 130;
/** Share of the mass a laser takes from a head it touches (and gives to its owner). */
export const TRAP_LASER_TAKE = 0.1;
export const TRAP_SLOW_S = 6;
export const TRAP_SLOW_R = 110;
export const TRAP_SLOW_FACTOR = 0.5;
/** Price of each trap as a share of the entry fee (percent), paid from the backpack. */
/** Price of a trap or a power, in percent of the entry fee (paid from the backpack, or from the bag in a room paid by bag). */
export const TRAP_PRICE_PCT: Readonly<Record<TrapKind, number>> = { 1: 10, 2: 5, 3: 0, 4: 5, 5: 0 };
export interface Trap { kind: number; owner: string; /** Heads this laser already hit. */ hit: string[]; x: number; y: number; x2: number; y2: number; r: number; until: number }

/** Distance from a point to a segment. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

export class Arena {
  /** Set by the server at start: when true, no power but the cash out can be used, in any mode. */
  static onlyCashout = false;
  /** How often (in steps) a bot's brain runs; 1 = every step. The live arenas set more to stay light. */
  brainEvery = 1;
  private halfCache = new Map<string, [number, number][]>();
  private halfStep = -1;
  /** Every other body point of a player, worked out once per step and shared by every bot's brain. */
  halfPoints(o: Player): [number, number][] {
    if (this.halfStep !== this.stepN) { this.halfStep = this.stepN; this.halfCache.clear(); }
    let v = this.halfCache.get(o.w);
    if (!v) { v = bodyPoints(o).filter((_, k) => k % 2 === 0); this.halfCache.set(o.w, v); }
    return v;
  }
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
  /** Traps on the map (rules 3): a laser behind a tail kills a head that touches it, a puddle slows the heads in it. */
  traps: Trap[] = [];
  private pendingTraps: { pi: number; kind: number }[] = [];
  /** Survival: when each dominant head last paid for knocking a body (by pair), so a rub costs once a second. */
  private knockAt = new Map<string, number>();

  /** A player sets a trap behind its tail; it is placed at the next step and written in the record (flag 4). */
  queueTrap(pi: number, kind: TrapKind): boolean {
    const p = this.players[pi];
    if (!p || !p.alive || this.rules < 3) return false;
    // Powers are off in every mode where the server says so (the test network): only the cash out stays.
    if (Arena.onlyCashout && kind !== POWER_CASHOUT) return false;
    if (kind !== TRAP_LASER && kind !== TRAP_SLOW && (this.rules < 6 || !this.powerAllowed(p, kind))) return false;
    if (this.spellCost(kind) > (p.bag ?? 0)) return false;
    this.pendingTraps.push({ pi, kind });
    return true;
  }

  /** Rules 6: whether this body may use this power now (the boss is near for a kamikaze, it is the boss for a shield...). */
  powerAllowed(p: Player, kind: number): boolean {
    if (kind === POWER_KAMIKAZE) {
      const b = this.boss();
      return !!b && b !== p && (b.shieldUntil ?? 0) <= this.time && this.nearestPoint(b, p.x, p.y) >= 0;
    }
    if (kind === POWER_SHIELD) return this.boss() === p && (p.shieldReady ?? 0) <= this.time;
    // Cash arena: you may only cash out after eliminating CASH_KILLS players who entered with at least as much as you.
    // In the cash arena only a body that paid an entry can cash out (a guest without a wallet plays for nothing).
    if (kind === POWER_CASHOUT) return p.cashoutAt === undefined && (!this.cash || (!!p.entry && (p.qk ?? 0) >= CASH_KILLS));
    return false;
  }
  /** Rules 6: the boss, the heaviest body alive when it weighs at least BOSS_MIN_MASS and twice the next one. */
  boss(): Player | null {
    if (this.rules < 6) return null;
    let a: Player | null = null, b: Player | null = null;
    for (const p of this.players) {
      if (!p.alive) continue;
      if (!a || p.m > a.m) { b = a; a = p; } else if (!b || p.m > b.m) b = p;
    }
    return a && a.m >= BOSS_MIN_MASS && a.m >= (b ? b.m : 0) * BOSS_LEAD ? a : null;
  }
  /** Rules 6: the boss cycle. "calm", "warn" (it will be exposed) or "open" (its back can be bitten), and seconds to the next change. */
  bossPhase(): { state: "calm" | "warn" | "open"; inS: number } {
    const t = this.time % BOSS_CYCLE_S, openAt = BOSS_CYCLE_S - BOSS_OPEN_S, warnAt = openAt - BOSS_WARN_S;
    if (t < warnAt) return { state: "calm", inS: warnAt - t };
    if (t < openAt) return { state: "warn", inS: openAt - t };
    return { state: "open", inS: BOSS_CYCLE_S - t };
  }
  /** Index of the point of body b nearest to (x, y) within KAMIKAZE_R, or -1. */
  private nearestPoint(b: Player, x: number, y: number): number {
    const pts = bodyPoints(b);
    let best = -1, bd = KAMIKAZE_R * KAMIKAZE_R;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  /** Rules 5 and 6, a room paid by bag: the entry fee, which prices the traps and powers paid from the bag. */
  bagFee = 0;
  /** Lamports spent from bags on traps and powers: they leave the players' pot and go to the house (maintenance). */
  bagSpent = 0;
  spellCost(kind: number): number {
    return this.bagFee > 0 ? Math.floor((this.bagFee * (TRAP_PRICE_PCT[kind as TrapKind] ?? 0)) / 100) : 0;
  }
  /** Takes `mass` from body b at point (x, y): `give` of it goes to the taker, the rest falls there as a coin with the same share of b's bag. */
  private chip(b: Player, mass: number, taker: Player | null, give: number, x: number, y: number, ev: StepResult): void {
    mass = Math.max(0, Math.min(mass, b.m - ARENA.minMass));
    if (mass <= 0) return;
    const share = b.bag ? Math.floor((b.bag * mass) / b.m) : 0;
    b.m -= mass;
    if (share) b.bag = (b.bag ?? 0) - share;
    const toTaker = taker ? mass * give : 0;
    if (taker) { taker.m += toTaker; if (taker.m > taker.peak) taker.peak = taker.m; }
    const o: Orb = { id: this.nextOrbId++, x: Math.round(x), y: Math.round(y), v: Math.round((mass - toTaker) * 1000) / 1000, loot: true };
    if (share) { o.l = share; o.c = "SOL"; o.q = share / 1e9; }
    this.orbs.push(o);
    ev.newOrbs.push(o);
  }
  /** Rules 6: a head on the exposed tail of the boss bites instead of dying (at most two bites a second per head). */
  private bossAt = new Map<string, number>();
  private bossBite(a: Player, b: Player, k: number, n: number, ev: StepResult): boolean {
    // Cash arena: while exposed, the boss (the richest) can be bitten anywhere on its body, not only the tail, and a bite takes more.
    if (this.rules < 6 || b !== this.bossNow || this.bossPhase().state !== "open" || (b.shieldUntil ?? 0) > this.time || (!this.cash && k < n * BOSS_TAIL)) return false;
    if ((this.bossAt.get(a.w) ?? -1) > this.time - 0.5) return true;
    this.bossAt.set(a.w, this.time);
    const pt = bodyPoints(b)[k] ?? [b.x, b.y];
    this.chip(b, b.m * BOSS_BITE * (this.cash ? 2.5 : 1), a, 0.5, pt[0], pt[1], ev);
    return true;
  }
  private bossNow: Player | null = null;

  private placeTrap(pi: number, kind: number, ev: StepResult): void {
    const p = this.players[pi];
    if (!p || !p.alive) return;
    if (this.rules >= 6 && !this.powerAllowed(p, kind) && kind !== TRAP_LASER && kind !== TRAP_SLOW) return;
    const cost = this.spellCost(kind);
    if (cost > (p.bag ?? 0)) return;
    if (cost) { p.bag = (p.bag ?? 0) - cost; this.bagSpent += cost; }
    if (kind === POWER_KAMIKAZE) {
      const b = this.boss()!;
      const at = bodyPoints(b)[this.nearestPoint(b, p.x, p.y)];
      this.chip(b, Math.min(b.m * KAMIKAZE_TAKE, p.m * 3 + 50), null, 0, at[0], at[1], ev);
      this.kill(p, "kamikaze", ev);
      return;
    }
    if (kind === POWER_SHIELD) {
      p.m = Math.max(ARENA.minMass, p.m * (1 - SHIELD_COST));
      p.shieldUntil = this.time + SHIELD_S;
      p.shieldReady = this.time + SHIELD_CD_S;
      return;
    }
    if (kind === POWER_CASHOUT) {
      p.cashoutAt = this.time;
      // Cash arena: the bag starts flowing to the wallet at once; what has left is safe, what is still in the bag can be lost.
      if (this.cash) {
        if (p.boostSpill) { p.bag = (p.bag ?? 0) + p.boostSpill; p.boostSpill = 0; }
        // What can leave grows with the fights won: the entry times (1 + eliminations of players with an entry like yours). The
        // rest of the bag stays in the game: it falls over the map for the others.
        const cap = this.cashCap(p);
        if ((p.bag ?? 0) > cap) { this.pendingSpill.push((p.bag ?? 0) - cap); p.bag = cap; }
        p.cashedBag = 0; p.cashBag0 = p.bag ?? 0; p.cashMass0 = p.m; this.cashOuts++;
      }
      return;
    }
    const pts = bodyPoints(p);
    const tail = pts[pts.length - 1];
    const prev = pts[Math.max(0, pts.length - 2)];
    let ux = tail[0] - prev[0], uy = tail[1] - prev[1];
    const len = Math.hypot(ux, uy) || 1;
    ux /= len; uy /= len;
    if (kind === TRAP_LASER) {
      // Rules 4: the laser is shot from the head, straight ahead, so it is aimed; before that it lay across the tail.
      if (this.rules >= 4) {
        const hx = Math.cos(p.heading), hy = Math.sin(p.heading), r0 = bodyRadius(p.m) + 18;
        this.traps.push({ kind, owner: p.w, hit: [], x: p.x + hx * r0, y: p.y + hy * r0, x2: p.x + hx * (r0 + TRAP_LASER_HALF * 2), y2: p.y + hy * (r0 + TRAP_LASER_HALF * 2), r: 0, until: this.time + TRAP_LASER_S });
      } else {
        const cx = tail[0] + ux * 24, cy = tail[1] + uy * 24;
        const h = TRAP_LASER_HALF;
        this.traps.push({ kind, owner: p.w, hit: [], x: cx - uy * h, y: cy + ux * h, x2: cx + uy * h, y2: cy - ux * h, r: 0, until: this.time + TRAP_LASER_S });
      }
    } else {
      this.traps.push({ kind, owner: p.w, hit: [], x: tail[0] + ux * 40, y: tail[1] + uy * 40, x2: 0, y2: 0, r: TRAP_SLOW_R, until: this.time + TRAP_SLOW_S });
    }
  }

  /** Speed factor of a head in a puddle that is not its own. */
  private slowOf(p: Player): number {
    for (const t of this.traps) {
      if (t.kind === TRAP_SLOW && t.owner !== p.w && Math.hypot(p.x - t.x, p.y - t.y) < t.r) return TRAP_SLOW_FACTOR;
    }
    return 1;
  }

  constructor(
    seed: number,
    entrants: { w: string; n: string; role: Role; bot: boolean }[],
    opts: { matchMs?: number; shrinkStartMs?: number; survival?: boolean; respawnBatch?: number; rules?: RulesVersion } = {},
  ) {
    this.rules = opts.rules ?? defaultRules;
    setRules(this.rules);
    this.survival = opts.survival === true;
    this.respawnBatch = opts.respawnBatch ?? 0;
    this.matchMs = opts.matchMs ?? ARENA.matchMs;
    this.shrinkStartMs = opts.shrinkStartMs ?? ARENA.shrinkStartMs;
    this.rng = new Rng(seed);
    const cx = ARENA.w / 2;
    const cy = ARENA.h / 2;
    this.zonePlan = buildZonePlan(this.rng, this.matchMs, this.shrinkStartMs, this.rules >= 4);
    entrants.forEach((e, i) => {
      // Spread the starts on a ring inside the zone, facing the center.
      const ang = (i / entrants.length) * Math.PI * 2 + (this.rules >= 4 ? 0 : this.rng.range(-0.1, 0.1));
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
    // Survival: the food follows the area of the map, so a bigger map is not an empty one.
    if (this.survival) return Math.min(4000, Math.round(900 * (this.mapR / ARENA.zoneR0) ** 2));
    return this.rules >= 5 ? this.coinCap(this.zone().r) : ARENA.orbTarget;
  }

  /**
   * Survival: the map is a circle that follows the leader, like slither.io. It grows as the heaviest body grows and, when that
   * body dies, shrinks back slowly (the bodies left outside take the zone damage, as in a normal match). Radius in world units.
   */
  mapR = ARENA.zoneR0;
  private mapTarget(): number {
    let top = 0;
    for (const p of this.players) if (p.alive && p.m > top) top = p.m;
    return Math.min(MAP_R_MAX, Math.max(ARENA.zoneR0, ARENA.zoneR0 * Math.sqrt(top / MAP_GROW_FROM)));
  }

  zoneNow(): ZoneState {
    if (this.survival) return { cx: ARENA.w / 2, cy: ARENA.h / 2, r: this.mapR, phase: 1, state: "hold", inSeconds: 0, target: null };
    return zoneState(this.zoneTime(), this.zonePlan);
  }

  zone(): Zone {
    return this.zoneNow();
  }

  private nextDrop: number = ARENA.airdropEveryS;
  /** When the last airdrop landed (and where): the snapshot of that moment says so, so the page can announce it. */
  dropAt: { x: number; y: number; t: number } | null = null;
  /** Seconds to the next airdrop. */
  nextDropIn(): number { return Math.max(0, this.nextDrop - this.time); }

  /** Survival: keeps a stock of tier 1 and tier 2 coins that follows how many bodies are big enough to eat them. */
  private stockTiers(ev: StepResult): void {
    const want = [0, 0, 0];
    for (const p of this.players) if (p.alive) { if (p.m >= ORB_TIER_MIN[1]) want[1] += 45; if (p.m >= ORB_TIER_MIN[2]) want[2] += 30; }
    const have = [0, 0, 0];
    for (const o of this.orbs) if (o.tier) have[o.tier]++;
    for (const tier of [1, 2] as const) {
      for (let i = have[tier]; i < Math.min(want[tier], 400); i++) {
        const o = this.newOrb();
        o.tier = tier;
        o.v = ORB_TIER_VALUE[tier] * (this.rules >= 4 ? 1 : 0.6 + this.rng.next() * 0.8);
        o.v = Math.round(o.v * 10) / 10;
        this.asCoin(o);
        this.orbs.push(o);
        ev.newOrbs.push(o);
      }
    }
  }

  /** Survival: the prices of the coins, taken once when the arena starts (dollars per coin). */
  coinPrices: Record<string, number> | null = null;

  /** Turns an orb into a coin of the market: picks the coin, and the amount of it worth the orb's mass at the start prices. */
  private asCoin(o: Orb): Orb {
    const prices = this.coinPrices;
    if (!prices) return o;
    let pick = (this.rules >= 4 ? goldenFrac(o.id) : this.rng.next()) * COIN_MIX.reduce((s2, c) => s2 + c[1], 0);
    let sym = COIN_MIX[0][0];
    for (const [c, w] of COIN_MIX) { if (pick < w) { sym = c; break; } pick -= w; }
    // A worthless orb never looks like SOL: only coins that really carry SOL are SOL.
    if (sym === "SOL") return o;
    const price = prices[sym];
    if (!(price > 0)) return o;
    // The amount, rounded to what a person would write (sats for BTC), and the mass it is really worth.
    const usd = o.v * USD_PER_MASS;
    const raw = usd / price;
    const q = sym === "BTC" ? Math.max(1, Math.round(raw * 1e8)) / 1e8 : Number(raw.toPrecision(2));
    o.c = sym;
    o.q = q;
    o.v = Math.max(0.1, Math.round(((q * price) / USD_PER_MASS) * 100) / 100);
    return o;
  }

  /** Rules 4: how many orbs and showers were laid, the position in their fixed patterns. */
  private orbSeq = 0;
  private placeSeq = 0;
  private dropSeq = 0;

  private newOrb(): Orb {
    // Uniform over the current safe zone, so loot always lies where people have to go.
    const z = this.zone();
    let a: number, r: number, v: number;
    if (this.rules >= 4) {
      // A fixed spiral over the zone, and a fixed cycle of values: the same map for everybody, every time.
      const n = this.orbSeq++;
      const [sa, sr] = spread(n);
      a = sa;
      r = sr * (z.r - 30);
      const c = n % 20;
      v = c < 14 ? ARENA.orbValues[0] : c < 19 ? ARENA.orbValues[1] : ARENA.orbValues[2];
    } else {
      a = this.rng.range(0, Math.PI * 2);
      r = Math.sqrt(this.rng.next()) * (z.r - 30);
      const k = this.rng.next();
      v = k < 0.7 ? ARENA.orbValues[0] : k < 0.93 ? ARENA.orbValues[1] : ARENA.orbValues[2];
    }
    const o: Orb = { id: this.nextOrbId++, x: Math.round(z.cx + Math.cos(a) * r), y: Math.round(z.cy + Math.sin(a) * r), v };
    return this.survival ? this.asCoin(o) : o;
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
    // The SOL a boost held goes back with the bag.
    if (p.boostSpill) { p.bag = (p.bag ?? 0) + p.boostSpill; p.boostSpill = 0; }
    // Cash arena: a kill counts toward cashing out when the victim entered with at least as much as the killer.
    if (this.cash) {
      const k = this.player(by);
      if (k && k !== p && k.bot) botLearn(k.w, true);
      if (p.bot) botLearn(p.w, false);
      if (k && k !== p && this.entryOf(p) >= this.entryOf(k)) k.qk = (k.qk ?? 0) + 1;
      if (k && k !== p) this.cashKills++;
      // The killer takes CASH_KILL_CUT of the victim's bag straight away; the rest falls over the map.
      if (k && k !== p && k.alive && p.bag) {
        const cut = Math.floor(p.bag * CASH_KILL_CUT);
        if (cut > 0) { this.cashCut += cut; p.bag -= cut; k.bag = (k.bag ?? 0) + cut; k.m += cut * CASH_MASS_PER_LAMPORT; ev.killCuts = ev.killCuts ?? []; ev.killCuts.push({ w: k.w, from: p.w, l: cut }); }
      }
    }
    p.alive = false;
    p.diedAt = this.time;
    p.killer = by;
    // Cash arena: a bot's entry ends with its life (it pays a new one when it comes back).
    if (this.cash && p.bot) { p.entry = undefined; p.qk = 0; }
    ev.deaths.push({ w: p.w, by });
    // 100% of the mass becomes orbs over the exact path of the body.
    const pts = bodyPoints(p);
    // Rules 8, a room paid by bag: every coin on the map is worth money, so a dead body drops only its bag (none at all when it is
    // empty), and one of the last three keeps its bag (it reached the final; the coins of its mass still fall, worthless ones do not).
    const keepBag = this.bagMode && this.freezeAt >= 0;
    // Never more coins than lamports: every coin carries at least one lamport, the smallest amount of SOL.
    const count = this.bagMode ? (p.bag && !keepBag ? Math.min(Math.max(24, this.cash ? Math.ceil((2 * p.bag) / this.cashMin) : 0), p.bag, Math.max(this.cash ? Math.ceil((2 * p.bag) / this.cashMin) : 1, Math.floor(p.m))) : 0) : Math.max(1, Math.min(ARENA.maxDeathOrbs, Math.floor(p.m)));
    // Version 2: a big body leaves richer orbs (up to half as much again), so beating a giant is worth the trouble.
    const value = (p.m / count) * (this.rules >= 2 ? 1 + Math.min(0.5, p.m / 6000) : 1);
    // Rules 4: the coins are scattered over the whole safe zone (the one thing left to the seed), not laid in a line where the
    // body was, so they do not all go to whoever happened to be next to it.
    const zl = this.rules >= 4 ? this.zone() : null;
    // Rules 8: the bag of a dead body falls in coins of different sizes too.
    const bagCut = this.rules >= 8 && p.bag && count ? unevenSplit(p.bag, count, this.stepN % 97).parts : null;
    for (let i = 0; i < count; i++) {
      let [x, y] = pts[Math.min(pts.length - 1, Math.floor((i * pts.length) / count))];
      if (zl) { const t = this.rng.range(0, Math.PI * 2), d = Math.sqrt(this.rng.next()) * Math.max(0, zl.r - 40); x = zl.cx + Math.cos(t) * d; y = zl.cy + Math.sin(t) * d; }
      const o: Orb = { id: this.nextOrbId++, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, v: Math.round(value * 1000) / 1000, loot: true };
      // Rules 5: the bag falls with the body, spread over its coins (the remainder on the first one).
      if (p.bag) {
        const l = bagCut ? bagCut[i] : Math.floor(p.bag / count) + (i === 0 ? p.bag % count : 0);
        if (l > 0) { o.l = l; o.c = "SOL"; o.q = l / 1e9; }
        // Cash arena: a coin's mass is what its SOL is worth, so growing means holding more SOL.
        if (this.cash) o.v = Math.max(0.05, Math.round(l * CASH_MASS_PER_LAMPORT * 100) / 100);
      }
      this.orbs.push(o);
      ev.newOrbs.push(o);
    }
    if (keepBag) p.banked = p.m; else p.bag = 0;
    p.m = 0;
    p.trail = [];
  }

  step(dt: number, brain?: (a: Arena, p: Player) => { dx: number; dy: number; boost: boolean }): StepResult {
    const ev: StepResult = { eatenOrbs: [], newOrbs: [], deaths: [] };
    setRules(this.rules);
    // Bag left behind by a capped cash out: spread over the map in coins of at most one entry.
    for (const l of this.pendingSpill.splice(0)) {
      const n = Math.max(1, Math.ceil(l / this.cashMin));
      for (let i = 0; i < n; i++) {
        const part = Math.floor(l / n) + (i === 0 ? l % n : 0);
        const a = this.rng.range(0, Math.PI * 2), d = Math.sqrt(this.rng.next()) * (this.mapR - 120);
        this.mintCoin(ARENA.w / 2 + Math.cos(a) * d, ARENA.h / 2 + Math.sin(a) * d, part, ev, Math.max(0.05, Math.round(part * CASH_MASS_PER_LAMPORT * 100) / 100));
      }
    }
    for (const q of this.pendingAway.splice(0)) {
      const pi = this.players.findIndex((x) => x.w === q.w);
      if (pi < 0) continue;
      const secs = q.back ? BACK_PROTECT_S : AWAY_PROTECT_S;
      this.players[pi].protectUntil = Math.max(this.players[pi].protectUntil, this.time + secs);
      if (!this.survival) this.inputLog.push([this.stepN, pi, 0, q.back ? 3 : 2]);
    }
    for (const q of this.pendingTraps.splice(0)) {
      this.placeTrap(q.pi, q.kind, ev);
      if (!this.survival) this.inputLog.push([this.stepN, q.pi, q.kind, 4]);
    }
    this.time += dt;
    setLengthCap(!this.survival);
    if (this.survival) {
      const want = this.mapTarget();
      this.mapR += Math.max(-MAP_SHRINK_PER_S * dt, Math.min(MAP_GROW_PER_S * dt, want - this.mapR));
    }
    const zoneNow = this.zoneNow();
    const cx = zoneNow.cx;
    const cy = zoneNow.cy;
    const zr = zoneNow.r;

    // Move.
    const tickNo = this.stepN++;
    for (let pi = 0; pi < this.players.length; pi++) {
      const p = this.players[pi];
      if (!p.alive) continue;
      // A bot decides every `brainEvery` steps (staggered by seat) and keeps its course in between: the live arenas run many bots.
      if ((p.bot || p.auto || p.afk) && brain && (this.brainEvery <= 1 || (tickNo + pi) % this.brainEvery === 0)) {
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

      let speed = speedOf(p.m) * (this.traps.length ? this.slowOf(p) : 1) * (p.cashoutAt !== undefined ? 0.5 : 1);
      if (p.boost && p.m > ARENA.minMass) {
        speed *= ARENA.boostSpeed;
        p.m = Math.max(ARENA.minMass, p.m - p.m * boostCostOf() * dt);
        // Cash arena: boosting costs SOL too, the same share of the bag as of the mass. It is held while you boost and pops out
        // behind your tail as one coin the moment you stop: the SOL changes hands, it never disappears.
        if (this.cash && p.bag) {
          const take = Math.min(p.bag, Math.max(1, Math.ceil(p.bag * boostCostOf() * dt)));
          p.bag -= take;
          p.boostSpill = (p.boostSpill ?? 0) + take;
        }
      } else if (p.boostSpill) {
        // The boost is over: its SOL explodes from the head and lands in fractions all over the map.
        const spill = p.boostSpill;
        p.boostSpill = 0;
        const n = Math.max(1, Math.min(12, Math.floor(spill / 20_000)));
        const cut = unevenSplit(spill, n, this.stepN % 97);
        const ids: number[] = [];
        for (let i = 0; i < n; i++) {
          const a = this.rng.range(0, Math.PI * 2), d = Math.sqrt(this.rng.next()) * Math.max(100, this.mapR - 120);
          const before = ev.newOrbs.length;
          this.mintCoin(ARENA.w / 2 + Math.cos(a) * d, ARENA.h / 2 + Math.sin(a) * d, cut.parts[i], ev, Math.max(0.05, Math.round(cut.parts[i] * CASH_MASS_PER_LAMPORT * 100) / 100));
          if (ev.newOrbs.length > before) ids.push(ev.newOrbs[ev.newOrbs.length - 1].id);
        }
        this.pops.push({ w: p.w, x: Math.round(p.x), y: Math.round(p.y), ids });
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
          // Survival: no length limit, so the path kept follows the body's own length.
          const keep = this.survival ? Math.round((ARENA.maxBodySegments * segmentSpacingOf(p.m) * (1 + (p.lengthBonus ?? 0))) / ARENA.trailSpacing) + 6 : trailKeep();
          if (p.trail.length > keep) p.trail.length = keep;
        }
      }
    }

    // The edge and the zone.
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.protectUntil > this.time) {
        // Protected: the edge cannot kill and the zone does not hurt yet; keep the head on the map.
        if (!this.survival) {
          p.x = Math.max(0, Math.min(ARENA.w, p.x));
          p.y = Math.max(0, Math.min(ARENA.h, p.y));
        }
        continue;
      }
      // Survival has no square wall: its edge is the circle of the map (the zone), which grows and shrinks.
      if (!this.survival && (p.x < 0 || p.y < 0 || p.x > ARENA.w || p.y > ARENA.h)) {
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

    // Traps: a laser takes a tenth of the mass of a head that touches it (once per head) and gives it to its owner; it never
    // kills. Not its owner's own head, not a protected one. Old traps go away.
    if (this.traps.length) {
      for (const t of this.traps) {
        if (t.kind !== TRAP_LASER) continue;
        const owner = this.players.find((q) => q.w === t.owner);
        for (const p of this.players) {
          if (!p.alive || p.w === t.owner || p.protectUntil > this.time || t.hit.includes(p.w)) continue;
          if (segDist(p.x, p.y, t.x, t.y, t.x2, t.y2) < bodyRadius(p.m)) {
            t.hit.push(p.w);
            const take = Math.max(0, Math.min(p.m - ARENA.minMass, p.m * TRAP_LASER_TAKE));
            p.m -= take;
            if (owner && owner.alive) { owner.m += take; if (owner.m > owner.peak) owner.peak = owner.m; }
          }
        }
      }
      this.traps = this.traps.filter((t) => t.until > this.time);
    }

    // Rules 5: the coins the zone leaves outside are part of the pot too. Once a second they fuse, slice by slice of the circle,
    // into one bigger coin that jumps back inside, so nothing of value is left where nobody can go.
    if (this.rules >= 5 && tickNo % ARENA.tickRate === 0) this.fuseOutside(cx, cy, zr, ev);
    // Rules 5: once the zone starts closing, coins lying close together fuse every few seconds, so the last ones are few and big.
    if (this.rules >= 5 && zoneNow.phase >= 2 && tickNo % (ARENA.tickRate * 4) === 0) this.fuseNear(ev);
    // Rules 5: the map never holds more coins than its area can show; the smallest ones fuse into their nearest neighbour.
    if (this.rules >= 5 && !this.survival && tickNo % ARENA.tickRate === 0) this.capCoins(zr, ev);
    // Cash arena: every 10 s the smallest SOL coins fuse into their nearest SOL coin, so the money on the map grows into fewer, bigger coins.
    // and every second the map never holds more than CASH_COIN_CAP coins (the server and the screens stay fast however long it runs).
    if (this.cash && tickNo % ARENA.tickRate === 0) {
      if (tickNo % (ARENA.tickRate * 10) === 0) this.growCoins(ev, 6, 30);
      this.growCoins(ev, 40, CASH_COIN_CAP);
    }
    // Rules 5, a room paid by bag: the showers of the pot.
    while (this.bagDrops.length && this.time >= this.bagDrops[0][0]) this.bagShower(this.bagDrops.shift()![1], ev);

    // Orbs.
    for (const p of this.players) {
      if (!p.alive || p.auto) continue;
      const r0 = bodyRadius(p.m) + 6;
      for (let i = this.orbs.length - 1; i >= 0; i--) {
        const o = this.orbs[i];
        const ddx = o.x - p.x;
        const ddy = o.y - p.y;
        // Cash arena: a coin is eaten when the head touches its drawn edge, so a big coin is eaten as soon as it looks touched.
        const r = this.cash ? r0 + 1.6 * (3 + 1.6 * Math.sqrt(Math.max(0, o.v))) : r0;
        if (Math.abs(ddx) <= r && Math.abs(ddy) <= r && ddx * ddx + ddy * ddy <= r * r) {
          // Cash arena: everybody paid to enter, so every orb is for everybody (no mass needed, no orb too small).
          if (this.survival && !this.cash && !canEatOrb(p.m, o)) continue;
          // A body cashing out eats nothing more: it is leaving.
          if (this.cash && p.cashoutAt !== undefined) continue;
          p.m += o.v;
          if (o.l) p.bag = (p.bag ?? 0) + o.l;
          if (p.m > p.peak) p.peak = p.m;
          ev.eatenOrbs.push(o.id);
          this.orbs.splice(i, 1);
        }
      }
    }

    // Rules 6: who is the boss in this step; and the bodies that finished cashing out leave the arena with what they carry.
    this.bossNow = this.boss();
    if (this.rules >= 6) {
      for (const p of this.players) {
        // Cash arena: while cashing out, the bag flows to the wallet evenly over CASHOUT_S and the body shrinks with it.
        if (this.cash && p.alive && p.cashoutAt !== undefined && p.cashedBag !== undefined) {
          const step = Math.min(p.bag ?? 0, Math.ceil(((p.cashBag0 ?? 0) / CASHOUT_S) * dt));
          if (step > 0) { p.bag = (p.bag ?? 0) - step; p.cashedBag += step; this.cashPaid += step; }
          // The body shrinks evenly to nothing over the cash out: whoever cashes out leaves the game, never plays on.
          p.m = Math.max(0.5, (p.cashMass0 ?? p.m) * (1 - Math.min(1, (this.time - p.cashoutAt) / CASHOUT_S)));
        }
        if (!p.alive || p.cashoutAt === undefined || this.time - p.cashoutAt < CASHOUT_S) continue;
        p.banked = p.m;
        // Cash arena: the bag leaves the arena with its owner.
        if (this.cash) { const rest = p.bag ?? 0; p.cashedBag = (p.cashedBag ?? 0) + rest; this.cashPaid += rest; p.bag = 0; }
        p.alive = false;
        p.diedAt = this.time;
        p.killer = "cashout";
        p.cashoutAt = undefined;
        p.trail = [];
        ev.deaths.push({ w: p.w, by: "cashout" });
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
          // Cash arena: the contact you see is the contact that counts, so a big head dies as soon as it touches a body.
          // Cash arena: a head dies when its edge touches the body's edge, exactly what the screen shows.
          const lim = this.cash ? rb + ra * 0.95 : rb + ra * 0.35;
          if (ddx * ddx + ddy * ddy < lim * lim) {
            // Survival: a body at least three times heavier (and the team's own) is not killed by a small one's body: it eats
            // a bite of it, which is mass for the big one and a shorter body for the small one.
            if (this.survival && this.rules >= 3 && !this.cash && (a.ceo || a.m >= b.m * 3)) {
              // Survival: the tail (its last quarter) of a body five times lighter is food: bit by bit its mass moves to the
              // big one. Anywhere else, a dominant head is not killed but pays for the knock, more the closer the two are.
              // Which part was hit: the point nearest to the head, not the first one within reach.
              let near = k, nd = ddx * ddx + ddy * ddy;
              for (let j = k + 1; j < pts.length; j++) {
                const ex = a.x - pts[j][0], ey = a.y - pts[j][1], e = ex * ex + ey * ey;
                if (e < nd) { nd = e; near = j; }
              }
              if (a.m >= b.m * 5 && near >= pts.length * 0.75) {
                const bite = Math.max(0.3, b.m * 0.012);
                b.m -= bite;
                a.m += bite;
                if (a.m > a.peak) a.peak = a.m;
                if (b.m < ARENA.deathMass && !dying.has(b.w)) dying.set(b.w, a.w);
              } else {
                // One knock per pair per second: a long rub costs one knock a second, not one every tick.
                const key = `${a.w}|${b.w}`;
                if ((this.knockAt.get(key) ?? -1) <= this.time - 1) {
                  this.knockAt.set(key, this.time);
                  const loss = a.m * Math.min(0.03, Math.max(0.004, (b.m / a.m) * 0.1));
                  a.m = Math.max(ARENA.minMass, a.m - loss);
                }
              }
              break;
            }
            if (this.rules >= 2 && !this.cash && (a.ceo || a.m >= b.m * 3)) {
              const bite = Math.max(0.4, b.m * 0.04);
              b.m -= bite;
              a.m += bite;
              if (a.m > a.peak) a.peak = a.m;
              if (b.m < ARENA.deathMass && !dying.has(b.w)) dying.set(b.w, a.w);
              break;
            }
            if (this.bossBite(a, b, k, pts.length, ev)) break;
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

    // Rules 7: the moment three bodies are left, the zone stops closing for FINAL3_FREEZE_S seconds.
    if (this.rules >= 7 && !this.survival && this.freezeAt < 0 && this.aliveCount() <= 3) this.freezeAt = this.time;

    // Airdrop: a cluster of rich coins somewhere inside the zone.
    if (this.time >= this.nextDrop && !this.bagMode) {
      this.nextDrop += this.survival ? 12 : ARENA.airdropEveryS;
      this.dropAt = { x: 0, y: 0, t: this.time };
      const z = this.zone();
      const fixed = this.rules >= 4;
      const dn = this.dropSeq++;
      const [da, dr] = spread(dn + 7);
      const a = fixed ? da : this.rng.range(0, Math.PI * 2);
      const rr = (fixed ? 0.2 + 0.6 * dr : Math.sqrt(this.rng.next())) * Math.max(0, z.r - 160);
      const cx = z.cx + Math.cos(a) * rr, cy = z.cy + Math.sin(a) * rr;
      if (this.dropAt) { this.dropAt.x = Math.round(cx); this.dropAt.y = Math.round(cy); }
      for (let i = 0; i < (this.survival ? 9 : ARENA.airdropOrbs); i++) {
        const t = fixed ? (i * Math.PI * 2) / 9 : this.rng.range(0, Math.PI * 2), d = fixed ? 45 : this.rng.range(0, 70);
        const o: Orb = { id: this.nextOrbId++, x: Math.round(cx + Math.cos(t) * d), y: Math.round(cy + Math.sin(t) * d), v: ARENA.airdropValue };
        this.orbs.push(o);
        ev.newOrbs.push(o);
      }
    }

    // Survival: big coins for big bodies, as many as there are bodies to eat them.
    if (this.survival && !this.bagMode) this.stockTiers(ev);
    // Keep the map stocked.
    let mapOrbs = this.survival ? this.orbs.reduce((n, o) => n + (o.tier ? 0 : 1), 0) : this.orbs.length;
    while (!this.bagMode && mapOrbs < this.foodTarget()) {
      const o = this.newOrb();
      this.orbs.push(o);
      ev.newOrbs.push(o);
      mapOrbs++;
    }
    if (this.survival) this.respawnBots();
    return ev;
  }

  /** Rules 7: when the zone froze for the last three (-1 until then), and the clock the zone follows (it skips the freeze). */
  freezeAt = -1;
  zoneTime(): number {
    if (this.freezeAt < 0) return this.time;
    return this.time < this.freezeAt + FINAL3_FREEZE_S ? this.freezeAt : this.time - FINAL3_FREEZE_S;
  }
  /** Rules 7: seconds left of the freeze of the last three, or 0. */
  freezeLeft(): number {
    return this.freezeAt < 0 ? 0 : Math.max(0, this.freezeAt + FINAL3_FREEZE_S - this.time);
  }

  /** Rules 5, a room paid by bag: the pot (lamports) still to fall as showers, [time in seconds, lamports]. */
  private bagDrops: [number, number][] = [];
  private bagSeq = 0;
  /** Rules 8: a room paid by bag, where every orb on the map is a coin of the pot (set by mintBags). */
  bagMode = false;
  /** Lamports minted into coins so far (equal to the pot once every shower fell). */
  bagMinted = 0;
  /**
   * Rules 5, a room paid by bag: the pot becomes coins. 30 percent falls at once over the zone, the other 70 in equal showers
   * every 15 seconds until 70 percent of the match. Every lamport is in exactly one coin; nothing is created.
   */
  mintBags(pool: number): StepResult {
    const ev: StepResult = { eatenOrbs: [], newOrbs: [], deaths: [] };
    if (this.rules < 5 || pool <= 0) return ev;
    const first = Math.floor(pool * 0.3);
    // Rules 8: the map holds only the pot. The free food goes and the pot falls in more, smaller coins.
    if (this.rules >= 8) {
      this.bagMode = true;
      for (const o of this.orbs) ev.eatenOrbs.push(o.id);
      this.orbs.length = 0;
    }
    const z = this.zone();
    const N = this.rules >= 8 ? 150 : 40;
    const cut = this.rules >= 8 ? unevenSplit(first, N, 3) : null;
    for (let i = 0; i < N; i++) {
      const [a, r] = spread(i + 501);
      const l = cut ? cut.parts[i] : Math.floor(first / N) + (i === 0 ? first % N : 0);
      // Rules 8: a coin is as big as it is rich (its mass follows its weight).
      const v = cut ? Math.round(Math.min(10, Math.max(1, (3 * cut.weights[i] * N) / cut.weights.reduce((x, y) => x + y, 0))) * 10) / 10 : 3;
      this.mintCoin(z.cx + Math.cos(a) * r * (z.r - 80), z.cy + Math.sin(a) * r * (z.r - 80), l, ev, v);
    }
    const until = (this.matchMs / 1000) * 0.7;
    const times: number[] = [];
    for (let t = 15; t <= until; t += 15) times.push(t);
    if (!times.length) times.push(1);
    const rest = pool - first;
    this.bagDrops = times.map((t, i) => [t, Math.floor(rest / times.length) + (i === 0 ? rest % times.length : 0)]);
    return ev;
  }
  private mintCoin(x: number, y: number, l: number, ev: StepResult, v = 3): void {
    if (l <= 0) return;
    const o: Orb = { id: this.nextOrbId++, x: Math.round(x), y: Math.round(y), v, l, c: "SOL", q: l / 1e9 };
    this.bagMinted += l;
    this.orbs.push(o);
    ev.newOrbs.push(o);
  }
  /** A shower of the pot: eight coins in a ring at a fixed spot of the zone. */
  private bagShower(total: number, ev: StepResult): void {
    const z = this.zone();
    const [a, r] = spread(this.bagSeq++ + 701);
    const cx = z.cx + Math.cos(a) * r * Math.max(0, z.r - 160), cy = z.cy + Math.sin(a) * r * Math.max(0, z.r - 160);
    const N = this.rules >= 8 ? 20 : 8;
    const cut = this.rules >= 8 ? unevenSplit(total, N, this.bagSeq * 7) : null;
    for (let i = 0; i < N; i++) {
      const t = (i * Math.PI * 2) / N;
      const v = cut ? Math.round(Math.min(10, Math.max(1, (3 * cut.weights[i] * N) / cut.weights.reduce((x, y) => x + y, 0))) * 10) / 10 : 3;
      this.mintCoin(cx + Math.cos(t) * 50, cy + Math.sin(t) * 50, cut ? cut.parts[i] : Math.floor(total / N) + (i === 0 ? total % N : 0), ev, v);
    }
  }
  /** Rules 5: how many coins the safe zone holds, in proportion to its area (600 on the full map, 40 at least). */
  coinCap(zr: number): number {
    return Math.max(40, Math.round(ARENA.orbTarget * (zr / ARENA.zoneR0) ** 2));
  }
  /** Rules 5: while the map holds more coins than the cap, the smallest coin fuses into the nearest one (value and lamports added). */
  private capCoins(zr: number, ev: StepResult): void {
    let extra = this.orbs.length - this.coinCap(zr);
    while (extra-- > 0 && this.orbs.length > 1) {
      let si = 0;
      for (let i = 1; i < this.orbs.length; i++) {
        const o = this.orbs[i], b = this.orbs[si];
        if (o.v < b.v || (o.v === b.v && o.id < b.id)) si = i;
      }
      const a = this.orbs[si];
      let ni = -1, nd = Infinity;
      for (let i = 0; i < this.orbs.length; i++) {
        if (i === si) continue;
        const d = (this.orbs[i].x - a.x) ** 2 + (this.orbs[i].y - a.y) ** 2;
        if (d < nd) { nd = d; ni = i; }
      }
      const b = this.orbs[ni];
      const l = (a.l ?? 0) + (b.l ?? 0);
      const o: Orb = { id: this.nextOrbId++, x: b.x, y: b.y, v: a.v + b.v, loot: true };
      if (l) { o.l = l; o.c = "SOL"; o.q = l / 1e9; }
      ev.eatenOrbs.push(a.id, b.id);
      this.orbs.splice(Math.max(si, ni), 1);
      this.orbs.splice(Math.min(si, ni), 1);
      this.orbs.push(o);
      ev.newOrbs.push(o);
    }
  }

  /** Cash arena: up to 6 of the smallest SOL coins fuse each into its nearest SOL coin (lamports added, mass follows the SOL), while
   *  more than 30 SOL coins lie on the map. Nothing is created or lost: the lamports of the two become the one. */
  private growCoins(ev: StepResult, merges: number, keep: number): void {
    for (let k = 0; k < merges; k++) {
      const sol = this.orbs.filter((o) => (o.l ?? 0) > 0);
      if (sol.length <= keep) return;
      let a = sol[0];
      for (const o of sol) if ((o.l ?? 0) < (a.l ?? 0) || ((o.l ?? 0) === (a.l ?? 0) && o.id < a.id)) a = o;
      // Never a coin worth more than one entry of this arena: the nearest coin it can join without passing that.
      let b: Orb | null = null, nd = Infinity;
      for (const o of sol) { if (o === a || (a.l ?? 0) + (o.l ?? 0) > this.cashMin) continue; const d = (o.x - a.x) ** 2 + (o.y - a.y) ** 2; if (d < nd) { nd = d; b = o; } }
      if (!b) return;
      const l = (a.l ?? 0) + (b.l ?? 0);
      const o: Orb = { id: this.nextOrbId++, x: b.x, y: b.y, v: Math.max(0.05, Math.round(l * CASH_MASS_PER_LAMPORT * 100) / 100), l, c: "SOL", q: l / 1e9, loot: true };
      (ev.fuses ??= []).push([a.x, a.y, b.x, b.y]);
      ev.eatenOrbs.push(a.id, b.id);
      this.orbs = this.orbs.filter((x) => x !== a && x !== b);
      this.orbs.push(o);
      ev.newOrbs.push(o);
    }
  }

  /** Rules 5: coins lying within 60 units of each other fuse into the bigger one's spot (value and lamports added). */
  private fuseNear(ev: StepResult): void {
    const R2 = 60 * 60;
    const gone = new Set<number>();
    const out: Orb[] = [];
    for (let i = 0; i < this.orbs.length; i++) {
      const a = this.orbs[i];
      if (gone.has(a.id) || a.tier) continue;
      let group: Orb[] | null = null;
      for (let j = i + 1; j < this.orbs.length; j++) {
        const b = this.orbs[j];
        if (gone.has(b.id) || b.tier) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy <= R2) { (group ??= [a]).push(b); gone.add(b.id); }
      }
      if (!group) continue;
      gone.add(a.id);
      const big = group.reduce((m, o) => (o.v > m.v ? o : m), group[0]);
      const v = group.reduce((n, o) => n + o.v, 0);
      const l = group.reduce((n, o) => n + (o.l ?? 0), 0);
      const o: Orb = { id: this.nextOrbId++, x: big.x, y: big.y, v, loot: true };
      if (l) { o.l = l; o.c = "SOL"; o.q = l / 1e9; }
      out.push(o);
    }
    if (!gone.size) return;
    for (let i = this.orbs.length - 1; i >= 0; i--) if (gone.has(this.orbs[i].id)) { ev.eatenOrbs.push(this.orbs[i].id); this.orbs.splice(i, 1); }
    for (const o of out) { this.orbs.push(o); ev.newOrbs.push(o); }
  }

  /** Rules 5: the orbs outside the zone fuse by slice of the circle (16 slices) into one orb a little inside the edge. */
  private fuseOutside(cx: number, cy: number, zr: number, ev: StepResult): void {
    const SLICES = 16;
    const groups = new Map<number, Orb[]>();
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      if (Math.hypot(o.x - cx, o.y - cy) <= zr) continue;
      const s = Math.floor((Math.atan2(o.y - cy, o.x - cx) / (Math.PI * 2) + 1) * SLICES) % SLICES;
      const list = groups.get(s);
      if (list) list.push(o); else groups.set(s, [o]);
      ev.eatenOrbs.push(o.id);
      this.orbs.splice(i, 1);
    }
    const inner = Math.max(0, zr - 140);
    for (const [s, list] of [...groups].sort((a, b) => a[0] - b[0])) {
      const a = ((s + 0.5) / SLICES) * Math.PI * 2;
      const v = list.reduce((n, o) => n + o.v, 0);
      const l = list.reduce((n, o) => n + (o.l ?? 0), 0);
      const o: Orb = { id: this.nextOrbId++, x: Math.round(cx + Math.cos(a) * inner), y: Math.round(cy + Math.sin(a) * inner), v, loot: true };
      if (l) { o.l = l; o.c = "SOL"; o.q = l / 1e9; }
      // A coin of the market keeps the name of its biggest piece, and an amount worth the whole fused value.
      const big = list.reduce((m, o) => (o.v > m.v ? o : m), list[0]);
      if (!l && big.c && big.q) { o.c = big.c; o.q = (big.q * v) / big.v; }
      const tier = list.reduce((m, o) => Math.max(m, o.tier ?? 0), 0);
      if (tier) o.tier = tier;
      this.orbs.push(o);
      ev.newOrbs.push(o);
    }
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
  /**
   * Cash arena (the live arena on the test network): every body that hits another body dies, big or small. A person enters with
   * an amount: 97 percent of it falls on the map as coins of different sizes, 3 percent goes to the house, and the person starts
   * small with an empty bag. Cashing out needs CASH_KILLS eliminations of players who entered with at least as much.
   */
  cash = false;
  /** Cash arena: boosts that just ended, their head and the coins their SOL became (told to the screens once, then cleared). */
  pops: { w: string; x: number; y: number; ids: number[] }[] = [];
  cashHouse = 0;
  cashPaid = 0;
  /** Cash arena tallies for the info panel: entries paid (count and lamports), eliminations, cash outs, the killers' 15% and players who left. */
  cashIn = 0;
  cashEntries = 0;
  cashKills = 0;
  cashOuts = 0;
  cashCut = 0;
  cashLeft = 0;
  /** Cash arena: the most a body can cash out now (its entry times one plus its qualifying eliminations). */
  cashCap(p: Player): number { return (p.entry ?? this.cashMin) * (1 + (p.qk ?? 0)); }
  /** Cash arena: bag above the cash out cap, to fall over the map at the next step. */
  private pendingSpill: number[] = [];
  /** Cash arena: the entry of this arena. */
  cashMin = CASH_MIN_ENTRY;
  // Only what was really paid counts: a body (bot or person) that entered with nothing is worth nothing to eliminate.
  entryOf(p: Player): number { return p.entry ?? 0; }
  cashEnter(p: Player, entry: number): StepResult {
    const ev: StepResult = { eatenOrbs: [], newOrbs: [], deaths: [] };
    // The bag is kept: whatever it ate before its entry was confirmed is real SOL from the map and stays its own.
    p.entry = entry; p.qk = 0; p.bag = p.bag ?? 0; p.cashedBag = undefined;
    this.cashIn += entry; this.cashEntries++;
    const fee = Math.floor((entry * 3) / 100);
    this.cashHouse += fee;
    const n = Math.max(6, Math.min(40, Math.round(entry / 300_000)));
    const cut = unevenSplit(entry - fee, n, Math.floor(this.time * 7) % 97);
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2), d = Math.sqrt(this.rng.next()) * (this.mapR - 120);
      // A coin's mass is what its SOL is worth (CASH_MASS_PER_LAMPORT).
      const v = Math.max(0.05, Math.round(cut.parts[i] * CASH_MASS_PER_LAMPORT * 100) / 100);
      this.mintCoin(ARENA.w / 2 + Math.cos(a) * d, ARENA.h / 2 + Math.sin(a) * d, cut.parts[i], ev, v);
    }
    return ev;
  }

  private placeSafely(p: Player, protectS: number): void {
    const cx = ARENA.w / 2, cy = ARENA.h / 2;
    let x = cx, y = cy, clear = -1;
    for (let tries = 0; tries < 12; tries++) {
      const fixed = this.rules >= 4;
      const sq = this.placeSeq++;
      const [pa, pr] = spread(sq + 13);
      const ang = fixed ? pa : this.rng.range(0, Math.PI * 2);
      const rad = (this.survival ? this.mapR : ARENA.zoneR0) * (0.25 + 0.6 * (fixed ? pr : this.rng.next()));
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
    p.trail = trail; p.protectUntil = this.time + protectS; p.diedAt = -1; p.killer = ""; p.lengthBonus = 0;
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
    p.entry = undefined; p.qk = 0;
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
/** Cash arena bots learn across lives: `bold` grows with each kill and shrinks with each death (0.6 to 1.6). */
const cashMind = new Map<string, { bold: number }>();
export function botLearn(w: string, killed: boolean): void {
  const m = cashMind.get(w) ?? { bold: 1 };
  m.bold = Math.max(0.6, Math.min(1.6, m.bold + (killed ? 0.08 : -0.05)));
  cashMind.set(w, m);
}
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
/** CEO mode (AFK): the best bot, but staying alive comes first: wider margins, a third look further ahead, and no ring
 *  hunting (circling a prey is where a body gets cut off). */
const levelOf = new WeakMap<Arena, Difficulty>();
/** Set once, for a practice match: its bots play at that level. Rooms with money keep the default (hard). */
export function setBotDifficulty(a: Arena, d: Difficulty): void { levelOf.set(a, d); }
export const isDifficulty = (v: unknown): v is Difficulty => v === "easy" || v === "medium" || v === "hard" || v === "insane";

export function arenaBrain(a: Arena, me: Player): { dx: number; dy: number; boost: boolean } {
  setRules(a.rules);
  if (me.afk) return ceoBrain(a, me);
  let st = brainMem.get(me);
  if (!st) { st = { orb: -1, until: 0, ang: me.heading, side: 0, d0: 0, t0: 0, ban: new Map(), prey: "", preyUntil: 0, circDir: 1, encT: 0 }; brainMem.set(me, st); }
  // A body played for its person (AFK) plays like the best bot there is.
  const P = LEVELS[levelOf.get(a) ?? "hard"];
  const zone = a.zone();
  const cx = zone.cx, cy = zone.cy, zr = zone.r;
  const bodyR = bodyRadius(me.m);
  const dc = Math.hypot(me.x - cx, me.y - cy);

  // The others: head and body points once per call.
  const others: { w: string; pts: [number, number][]; r: number; heavier: boolean; hx: number; hy: number; prot: boolean; hd: number; m: number; bag: number; human: boolean }[] = [];
  // The live arenas (many bots, `brainEvery` > 1) look only at what is near: body points within 800 of the head, far beyond any
  // reach the brain tests, and the points of each body are worked out once per step for every bot.
  const light = a.brainEvery > 1;
  for (const o of a.players) {
    if (o === me || !o.alive) continue;
    let pts = light ? a.halfPoints(o) : bodyPoints(o).filter((_, k) => k % 2 === 0);
    if (light) { pts = pts.filter((q) => Math.abs(q[0] - me.x) < 800 && Math.abs(q[1] - me.y) < 800); if (!pts.length && Math.hypot(o.x - me.x, o.y - me.y) > 800) continue; }
    others.push({ w: o.w, hd: o.heading, m: o.m, pts, r: bodyRadius(o.m), heavier: o.m > me.m * 0.95, hx: o.x, hy: o.y, prot: o.protectUntil > a.time, bag: o.bag ?? 0, human: !o.bot });
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
        if (d > (a.cash && (o.l ?? 0) > 0 ? P.orbRange * 2.2 : o.loot ? P.orbRange * 1.4 : P.orbRange)) continue;
        if ((st.ban.get(o.id) ?? 0) > a.time) continue;
        const turn = Math.abs(angDiff(Math.atan2(o.y - me.y, o.x - me.x), st.ang));
        // What a body left behind is worth more than its mass: it is free food, and somebody else is going for it.
        // A pile of food in the middle of three bigger bodies is not worth it: the more dangerous heads near an orb, the less it is worth.
        let risk = 0;
        for (const q of others) { if (q.heavier && Math.hypot(q.hx - o.x, q.hy - o.y) < 260) risk++; }
        // Cash arena: a coin with SOL is what the game is about; a bot wants it far more than plain food.
        const rich = a.cash && (o.l ?? 0) > 0 ? 8 : 1;
        const sc = (1 + o.v * (o.loot ? P.loot : 1)) * rich / ((d + 60) * (1 + 0.9 * risk)) - turn * 0.0009;
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
  // Cash arena: every bot hunts. Nobody is immune and a head that touches a body dies, so size does not protect anyone: the bot
  // goes for whoever carries the most SOL (people first), cuts in front of its head instead of chasing its tail, and boosts in.
  // It learns: a bot whose hunts end in kills grows bolder, one that keeps dying grows careful (kept per bot across lives).
  if (a.cash && !nearEdge && me.m > 22) {
    const mem = cashMind.get(me.w) ?? { bold: 1 };
    cashMind.set(me.w, mem);
    let best: (typeof others)[number] | undefined, bestS = 0, bestD = 0;
    for (const o of others) {
      if (o.prot) continue;
      const dd = Math.hypot(o.hx - me.x, o.hy - me.y);
      if (dd > P.huntRange * mem.bold) continue;
      const sc = (1 + o.bag / Math.max(1, a.cashMin)) * (o.human ? 1.6 : 1) / (dd + 120);
      if (sc > bestS) { bestS = sc; best = o; bestD = dd; }
    }
    if (best) {
      // A point ahead of its head, a little to our side: our body ends up across its path.
      const ahead = speedOf(best.m) * Math.min(1.1, bestD / 300) + 90;
      const tx = best.hx + Math.cos(best.hd) * ahead, ty = best.hy + Math.sin(best.hd) * ahead;
      want = Math.atan2(ty - me.y, tx - me.x);
      preyW = best.w;
      chasing = bestD < 450 * mem.bold;
    }
  } else
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
      if (!a.survival && (tx < 30 || ty < 30 || tx > ARENA.w - 30 || ty > ARENA.h - 30)) cost += 900 * w;
      const dz = Math.hypot(tx - cx, ty - cy);
      if (dz > zr - 30) cost += (240 + (dz - (zr - 30))) * w;
      // Somebody else's laser takes a tenth of the mass, a puddle slows: both are worth a detour.
      for (const t of a.traps) {
        if (t.owner === me.w) continue;
        if (t.kind === TRAP_LASER && segDist(tx, ty, t.x, t.y, t.x2, t.y2) < bodyR + 30) cost += 300 * w;
        else if (t.kind === TRAP_SLOW && Math.hypot(tx - t.x, ty - t.y) < t.r) cost += 120 * w;
      }
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

// ───────────── CEO mode: the best player there is, under the same rules as everybody ─────────────
// It looks ahead instead of reacting: every tick it simulates 24 headings, with and without the boost, 1.4 seconds into the future,
// with the turning limit of its mass. Each path is scored by what would happen on it: crossing a body or meeting a heavier (or
// equal) head head on is fatal, leaving the zone costs, open space ahead is worth a lot (so an encircling ring is left through its
// widest gap before it closes), a lighter head on the path is a kill. The boost costs mass like for anybody, so it is used only
// to get out of danger or to close on prey worth more than what the burst burns.
const ceoMem = new WeakMap<Player, { ang: number; orb: number; orbUntil: number }>();
const CEO_DIRS = 24;
const CEO_T = 1.4;
const CEO_DT = 0.1;
/** Weights of the CEO brain (exported so a simulation can tune them). */
export const CEO_K = { goal: 420, open: 1.5, preyRange: 1100, preyBonus: 2500, orbRange: 1600, risk: 1.2 };

export function ceoBrain(a: Arena, me: Player): { dx: number; dy: number; boost: boolean } {
  let st = ceoMem.get(me);
  if (!st) { st = { ang: me.heading, orb: -1, orbUntil: 0 }; ceoMem.set(me, st); }
  const zone = a.zone();
  const R = bodyRadius(me.m);
  const v = speedOf(me.m);
  const canBoost = me.m > ARENA.minMass + 15;
  const vB = v * ARENA.boostSpeed;
  const turnRate0 = turnRateOf(me.m);
  // A big body turns wide: it looks further ahead and keeps its whole turning circle (and then some) inside the zone.
  const horizon = Math.min(3.2, Math.max(CEO_T, (Math.PI / turnRate0) * 0.9));
  const steps = Math.round(horizon / CEO_DT);
  const turnR = v / turnRate0;
  const edgeMargin = R + turnR * 1.4 + 160;
  const near = vB * horizon + 450;

  // The others: their head, where it is going, and only the body points close enough to matter.
  type O = { w: string; m: number; r: number; hx: number; hy: number; vx: number; vy: number; pts: [number, number][]; tailPts: [number, number][]; danger: boolean; prey: boolean; knock: boolean };
  const os: O[] = [];
  for (const o of a.players) {
    if (o === me || !o.alive) continue;
    const pts: [number, number][] = [];
    const tailPts: [number, number][] = [];
    const bp = bodyPoints(o);
    const tailFrom = bp.length * 0.75;
    for (let k = 1; k < bp.length; k++) {
      if (Math.abs(bp[k][0] - me.x) >= near || Math.abs(bp[k][1] - me.y) >= near) continue;
      (a.survival && me.m >= o.m * 5 && k >= tailFrom ? tailPts : pts).push(bp[k]);
    }
    const dh = Math.hypot(o.x - me.x, o.y - me.y);
    if (pts.length === 0 && tailPts.length === 0 && dh > near) continue;
    const sp = speedOf(o.m) * (o.boost ? ARENA.boostSpeed : 1);
    const protectedNow = o.protectUntil > a.time;
    os.push({
      w: o.w, m: o.m, r: bodyRadius(o.m), hx: o.x, hy: o.y, vx: Math.cos(o.heading) * sp, vy: Math.sin(o.heading) * sp, pts, tailPts,
      // Survival: three times heavier, its body is a knock that costs mass, not a death.
      knock: a.survival && me.m >= o.m * 3,
      danger: o.m >= me.m * 0.98 || protectedNow, prey: !protectedNow && o.m * 1.1 < me.m,
    });
  }

  // What it wants: the best lighter head within reach (aimed where it will be), else the richest food that is safe to take.
  let goal: { x: number; y: number } | null = null;
  let preyWorth = 0;
  let bestPrey = 0;
  for (const o of os) {
    if (!o.prey) continue;
    const d = Math.hypot(o.hx - me.x, o.hy - me.y);
    if (d > CEO_K.preyRange) continue;
    if (Math.hypot(o.hx - zone.cx, o.hy - zone.cy) > zone.r - edgeMargin) continue;
    const score = o.m / (d + 120);
    if (score > bestPrey) {
      bestPrey = score;
      const lead = Math.min(1.2, d / vB);
      goal = { x: o.hx + o.vx * lead, y: o.hy + o.vy * lead };
      preyWorth = o.m;
    }
  }
  if (!goal) {
    let target = a.orbs.find((o) => o.id === st!.orb);
    if (!target || a.time > st.orbUntil) {
      let best = -Infinity;
      target = undefined;
      for (const o of a.orbs) {
        const d = Math.hypot(o.x - me.x, o.y - me.y);
        if (d > CEO_K.orbRange) continue;
        if (Math.hypot(o.x - zone.cx, o.y - zone.cy) > zone.r - edgeMargin) continue;
        if (a.survival && !canEatOrb(me.m, o)) continue;
        let risk = 0;
        for (const q of os) if (q.danger && Math.hypot(q.hx - o.x, q.hy - o.y) < 300) risk++;
        const sc = (1 + o.v * (o.loot ? 4 : 1)) / ((d + 60) * (1 + CEO_K.risk * risk));
        if (sc > best) { best = sc; target = o; }
      }
      if (target) { st.orb = target.id; st.orbUntil = a.time + 1.5; }
    }
    goal = target ? { x: target.x, y: target.y } : { x: zone.cx, y: zone.cy };
  }
  const goalAng = Math.atan2(goal.y - me.y, goal.x - me.x);
  const turnRate = turnRate0;

  let bestCost = Infinity, bestAng = st.ang, bestBoost = false, safeWithout = Infinity;
  for (let k = 0; k < CEO_DIRS; k++) {
    const ang = st.ang + angDiff((k * Math.PI * 2) / CEO_DIRS, 0) ;
    for (const boost of canBoost ? [false, true] : [false]) {
      const sp = boost ? vB : v;
      let x = me.x, y = me.y, h = st.ang, cost = 0;
      let hitAt = -1;
      for (let i = 1; i <= steps && hitAt < 0; i++) {
        const t = i * CEO_DT;
        const d = angDiff(ang, h);
        h += Math.max(-turnRate * CEO_DT, Math.min(turnRate * CEO_DT, d));
        x += Math.cos(h) * sp * CEO_DT;
        y += Math.sin(h) * sp * CEO_DT;
        const urgency = 1.6 - t / horizon;
        for (const o of os) {
          const lim = R + o.r * 0.9 + 8;
          for (const pt of o.pts) {
            if (Math.abs(pt[0] - x) < lim && Math.abs(pt[1] - y) < lim && Math.hypot(pt[0] - x, pt[1] - y) < lim) {
              if (o.knock) { cost += (2500 + me.m * 0.03 * 25) * urgency; break; }
              hitAt = t; break;
            }
          }
          if (hitAt >= 0) break;
          for (const pt of o.tailPts) if (Math.hypot(pt[0] - x, pt[1] - y) < lim) { cost -= o.m * 0.4 * urgency; break; }
          const px = o.hx + o.vx * t, py = o.hy + o.vy * t;
          const dh = Math.hypot(px - x, py - y);
          if (dh < R + o.r + 14) {
            if (o.danger) { hitAt = t; break; }
            if (o.prey) cost -= CEO_K.preyBonus * urgency;
          } else if (o.danger && dh < R + o.r + 90) cost += 300 * urgency * (1 - (dh - R - o.r - 14) / 76);
        }
        if (hitAt >= 0) { cost += 20_000 * urgency; break; }
        // The edge: past the margin it costs, past the zone itself it is as bad as a crash (the zone eats a big body fast).
        const dz = Math.hypot(x - zone.cx, y - zone.cy);
        if (dz > zone.r - R) { cost += 20_000 * urgency; hitAt = t; }
        else if (dz > zone.r - edgeMargin) cost += (900 + (dz - zone.r + edgeMargin) * 25) * urgency;
      }
      // Open space beyond the horizon: how far it could keep going this way before meeting a body.
      if (hitAt < 0) {
        let free = 0;
        const ux = Math.cos(h), uy = Math.sin(h);
        outer: for (let s2 = 40; s2 <= 640; s2 += 40) {
          const qx = x + ux * s2, qy = y + uy * s2;
          if (Math.hypot(qx - zone.cx, qy - zone.cy) > zone.r - edgeMargin) break;
          for (const o of os) for (const pt of o.pts) if (Math.abs(pt[0] - qx) < R + o.r && Math.abs(pt[1] - qy) < R + o.r) break outer;
          free = s2;
        }
        cost -= free * CEO_K.open;
      }
      cost += Math.abs(angDiff(ang, goalAng)) * CEO_K.goal;
      cost += Math.abs(angDiff(ang, st.ang)) * 25;
      // The burst burns mass: worth it only to get out of danger or to close on prey richer than what it burns.
      if (boost) {
        const burn = me.m * boostCostOf() * horizon;
        cost += burn * 40;
        if (preyWorth > 0 && Math.abs(angDiff(ang, goalAng)) < 0.5) cost -= Math.min(preyWorth, 4 * burn) * 25;
      }
      if (cost < bestCost) { bestCost = cost; bestAng = ang; bestBoost = boost; }
      if (!boost && hitAt < 0 && cost < safeWithout) safeWithout = cost;
    }
  }
  // Never burn mass when a calm path is just as good.
  if (bestBoost && safeWithout < bestCost + 60) bestBoost = false;
  const step = turnRate / ARENA.tickRate;
  st.ang += Math.max(-step, Math.min(step, angDiff(bestAng, st.ang)));
  return { dx: Math.cos(st.ang), dy: Math.sin(st.ang), boost: bestBoost };
}
