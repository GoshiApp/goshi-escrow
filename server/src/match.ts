import { createHash } from "node:crypto";
import { arenaReplayHash, encodeArenaReplay } from "./game/arena-replay.js";
import { BOT_SKINS } from "./game/skins.js";
import { ARENA, Arena, POWER_CASHOUT, POWER_KAMIKAZE, POWER_SHIELD, TRAP_PRICE_PCT, ZONE_RADII, arenaBrain, bodyPoints, bodyRadius, setRules, type Orb, type Role, type RulesVersion, type TrapKind } from "./game/arena.js";
/** Two traps from the same player are at least this far apart. */
const TRAP_COOLDOWN_MS = 4000;
/** Bought length in survival: each purchase adds this much, up to the maximum. */
export const LENGTH_STEP = 0.05;
export const LENGTH_MAX = 0.2;
/** Price of one step of length, in lamports: half to maintenance (infra wallet), half to the project (liquidity wallet). */
export const LENGTH_PRICE = 10_000_000n;
import {
  FRENZY, Recorder, angleByte, buildMap, carriedMass, encodeReplay, frenzyBrain, frenzyBrainLevel, FRENZY_LEVELS, type FrenzyLevel, newPlayer, replayHash, stepPlayer,
  type FrenzyMap, type FrenzyPlayer, type PriceSnapshot,
} from "./game/frenzy.js";

export interface MatchPlayer {
  w: string;
  n: string;
  role: Role;
  bot: boolean;
  /** Cosmetic skin id, already validated by the hub. */
  skin?: string;
}

export interface MatchResult {
  mode: "royale" | "vs" | "duel";
  ranking: { w: string; rank: number; score: number; role: Role }[];
}

/** The frozen inputs of the minute of frenzy. Absent: the match is only the arena (used by some tests). */
export interface FrenzyOptions {
  snapshot: PriceSnapshot;
  /** sha256 of the secret the server committed to when the room was created (hex), shown to the players. */
  commit: string;
  /** Hex of the signature of the snapshot hash by the platform key. */
  signature: string;
}

/** The transition between the minute and the arena, in milliseconds. */
export const FRENZY_GAP_MS = 3000;

const STEP = 1 / ARENA.tickRate;

/** One running match. Pure game plus a timer: it never touches the network or the chain. */
/** An orb as it travels: a coin of the market in survival (c, q), a plain orb elsewhere. */
/** `t` (a big orb that needs mass) is only told where that rule applies: the cash arena has no such orbs. */
const orbMsg = (o: Orb, cash = false) => ({ id: o.id, x: o.x, y: o.y, v: o.v, ...(o.c ? { c: o.c, q: o.q } : {}), ...(o.tier && !cash ? { t: o.tier } : {}) });

export class Match {
  readonly arena: Arena;
  /** Start of the arena phase (a minute plus a short gap after `startsAt` when there is a frenzy). */
  readonly arenaStartsAt: number;
  private stage: "frenzy" | "gap" | "arena";
  /** The arena phase is on (the minute of frenzy is over): bodies can be handed to late joiners. */
  get inArena(): boolean { return !this.ended && this.stage === "arena"; }
  private fmap?: FrenzyMap;
  private fplayers = new Map<string, { st: FrenzyPlayer; rec: Recorder; dx: number; dy: number; nitro: boolean; bot: boolean; jitter: number; moved: boolean }>();
  private ftick = 0;
  private facc = 0;
  private flast = 0;
  /** Practice: how well the bots play the minute of frenzy (the same level as in the arena). Unset: the standard bot. */
  private frenzyLevel?: FrenzyLevel;
  private replays = new Map<string, { bytes: Uint8Array; hash: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private acc = 0;
  private last = 0;
  private pendingEaten: number[] = [];
  private pendingNew: Orb[] = [];
  private pendingFuses: [number, number, number, number][] = [];
  private pendingEvents: { k: "death"; w: string; by: string; rank: number }[] = [];
  private tick = 0;
  private matchMs: number;
  ended = false;

  constructor(
    readonly roomId: string,
    readonly mode: "royale" | "vs" | "duel",
    readonly players: MatchPlayer[],
    seed: number,
    matchMs: number,
    readonly startsAt: number,
    private onSnap: (msg: object) => void,
    private onEnd: (res: MatchResult) => void,
    private shrinkStartMs: number = ARENA.shrinkStartMs,
    readonly frenzyOpts?: FrenzyOptions,
    survival = false,
    respawnBatch = 0,
    /** The rules of this arena; unset, the server's default (a free practice may run newer rules than the paid rooms). */
    rules?: RulesVersion,
  ) {
    this.matchMs = matchMs;
    // Bots wear the meme and coin skins in turn (cosmetic: never changes a rule).
    players.forEach((p, i) => { if (p.bot && !p.skin) p.skin = BOT_SKINS[i % BOT_SKINS.length]; });
    this.arena = new Arena(seed, players, { matchMs, shrinkStartMs, survival, respawnBatch, ...(rules ? { rules } : {}) });
    this.seed = seed;
    if (frenzyOpts) {
      this.fmap = buildMap(seed, frenzyOpts.snapshot);
      let i = 0;
      for (const p of players) {
        this.fplayers.set(p.w, { st: newPlayer(), rec: new Recorder(), dx: 1, dy: 0, nitro: false, bot: p.bot, jitter: (i++ * 37) % 64 - 32, moved: p.bot });
      }
      this.stage = "frenzy";
      this.arenaStartsAt = startsAt + FRENZY.ms + FRENZY_GAP_MS;
    } else {
      this.stage = "arena";
      this.arenaStartsAt = startsAt;
    }
  }
  private readonly seed: number;
  /** The mass every player enters the arena with (from the minute of frenzy), part of the match record. */
  private arenaStartMass = new Map<string, number>();

  roles(): Record<string, Role> {
    return Object.fromEntries(this.players.map((p) => [p.w, p.role]));
  }

  startMsg(you: string) {
    return {
      t: "start",
      roomId: this.roomId,
      mode: this.mode,
      startsAt: this.arenaStartsAt,
      matchMs: this.matchMs,
      shrinkStartMs: this.shrinkStartMs,
      world: { w: ARENA.w, h: ARENA.h },
      zone: { cx: ARENA.w / 2, cy: ARENA.h / 2, r0: ARENA.zoneR0, rMin: ARENA.zoneRMin, radii: ZONE_RADII },
      orbs: this.arena.orbs.map((o) => orbMsg(o, this.arena.cash)),
      you,
      roles: this.roles(),
      skins: this.skinsMap(),
      ...(this.fmap && this.frenzyOpts
        ? {
            frenzy: {
              startsAt: this.startsAt,
              ms: FRENZY.ms,
              tickRate: FRENZY.tickRate,
              start: { x: FRENZY.startX, y: FRENZY.startY, m: FRENZY.startMass },
              carryCap: FRENZY.carryCap,
              map: {
                w: this.fmap.w,
                h: this.fmap.h,
                gems: this.fmap.gems.map((g) => [g.id, g.x, g.y, g.s, g.m, g.btc ? 1 : 0]),
                walls: this.fmap.walls.map((q) => [q.x, q.y, q.w, q.h]),
                lasers: this.fmap.lasers.map((q) => [q.x, q.y, q.w, q.h, q.off]),
                laserPeriod: FRENZY.laserPeriod,
                laserOn: FRENZY.laserOn,
                btcRespawnMs: (FRENZY.btcRespawnTicks / FRENZY.tickRate) * 1000,
              },
              snapshot: this.frenzyOpts.snapshot,
              commit: this.frenzyOpts.commit,
              signature: this.frenzyOpts.signature,
            },
          }
        : {}),
    };
  }

  /** A seated player's connection dropped in the arena: the bot plays their body, protected (the frenzy minute hurts nobody). */
  away(wallet: string): boolean {
    if (this.ended || this.stage !== "arena") return false;
    return this.arena.away(wallet);
  }

  setFrenzyLevel(level: FrenzyLevel): void { this.frenzyLevel = level; }

  /** Rules 5, a room paid by bag: the lamports minted into coins (0 when the room pays by place). */
  bagPool = 0;
  /** Cash arena: a person enters with `entry` lamports; its coins fall on the map with the next picture. */
  cashEnter(wallet: string, entry: number): void {
    const p = this.arena.player(wallet);
    if (!p || !this.arena.cash) return;
    const ev = this.arena.cashEnter(p, entry);
    this.pendingNew.push(...ev.newOrbs);
  }

  /** Mints the pot into coins before the start messages go out (the first wave lies on the map from the beginning). */
  setBags(pool: bigint): void {
    if (this.bagPool || pool <= 0n || this.arena.rules < 5) return;
    this.bagPool = Number(pool);
    this.arena.bagFee = Number(this.fee);
    this.arena.mintBags(this.bagPool);
  }
  /**
   * What every paid seat is paid at the end, in seat order. A body alive keeps its bag. What nobody holds (coins left on the map,
   * coins not yet fallen and the bags of the saboteurs) is split in equal parts among the best three paid players; the remainder
   * of that split goes to the first. The sum is always the whole pot.
   */
  bagsFor(paid: string[]): bigint[] {
    const a = this.arena;
    const own = new Map<string, number>();
    let held = 0;
    // A body alive, or one that cashed out, keeps its bag. What was spent on traps and powers went to the house.
    for (const p of a.players) if ((p.alive || p.banked !== undefined) && p.role === "paid" && p.bag) { own.set(p.w, p.bag); held += p.bag; }
    const rest = this.bagPool - held - a.bagSpent;
    const top = a.ranking().filter((r) => r.role === "paid").slice(0, 3).map((r) => r.w);
    if (top.length && rest > 0) {
      const each = Math.floor(rest / top.length);
      top.forEach((w, i) => own.set(w, (own.get(w) ?? 0) + each + (i === 0 ? rest - each * top.length : 0)));
    }
    return paid.map((w) => BigInt(own.get(w) ?? 0));
  }

  /** v6 backpacks: what each paid seat can still spend on traps (lamports) and the entry fee that sets the prices. */
  private backpack = new Map<string, { left: bigint; spent: bigint }>();
  private fee = 0n;
  private trapAt = new Map<string, number>();
  setBackpacks(paid: string[], backpacks: bigint[], fee: bigint): void {
    this.fee = fee;
    paid.forEach((w, i) => { if ((backpacks[i] ?? 0n) > 0n) this.backpack.set(w, { left: backpacks[i], spent: 0n }); });
  }
  /** Survival: one more step of bought length for this body (+5 percent, at most +20). Returns the new bonus, or null. */
  growLength(wallet: string): number | "max" | null {
    const p = this.arena.players.find((q) => q.w === wallet);
    if (!this.arena.survival || !p || !p.alive) return null;
    const now = p.lengthBonus ?? 0;
    if (now >= LENGTH_MAX - 1e-9) return "max";
    p.lengthBonus = Math.min(LENGTH_MAX, now + LENGTH_STEP);
    return p.lengthBonus;
  }

  /** What each paid seat spent on traps, in seat order (for settle_backpacks). */
  spentFor(paid: string[]): bigint[] {
    return paid.map((w) => this.backpack.get(w)?.spent ?? 0n);
  }
  /** Price of a trap in this room (lamports): a share of the entry fee. */
  trapPrice(kind: TrapKind): bigint {
    return (this.fee * BigInt(TRAP_PRICE_PCT[kind])) / 100n;
  }
  /**
   * A player sets a trap. In a room with money it is paid from the backpack (never more than it holds); in a free match it
   * costs nothing but waits a few seconds between two traps. Returns what is left in the backpack, or why it was refused.
   */
  trap(wallet: string, kind: TrapKind, free: boolean): { ok: true; left: string } | { ok: false; reason: "not_now" | "no_backpack" | "too_soon" } {
    if (this.ended || this.stage !== "arena") return { ok: false, reason: "not_now" };
    // Cash arena: no lasers, puddles, kamikaze or shields (they confused more than they helped); only cashing out.
    if (this.arena.cash && kind !== POWER_CASHOUT) return { ok: false, reason: "not_now" };
    const pi = this.arena.players.findIndex((p) => p.w === wallet);
    if (pi < 0 || !this.arena.players[pi].alive) return { ok: false, reason: "not_now" };
    const now = Date.now();
    if (now - (this.trapAt.get(wallet) ?? 0) < TRAP_COOLDOWN_MS) return { ok: false, reason: "too_soon" };
    // A room paid by bag: the arena charges the bag itself (and the record replays it), no backpack.
    if (!free && this.bagPool) free = true;
    if (!free) {
      const b = this.backpack.get(wallet);
      const price = this.trapPrice(kind);
      if (!b || price <= 0n || b.left < price) return { ok: false, reason: "no_backpack" };
      if (!this.arena.queueTrap(pi, kind)) return { ok: false, reason: "not_now" };
      b.left -= price;
      b.spent += price;
      this.trapAt.set(wallet, now);
      return { ok: true, left: b.left.toString() };
    }
    if (!this.arena.queueTrap(pi, kind)) return { ok: false, reason: "not_now" };
    this.trapAt.set(wallet, now);
    return { ok: true, left: "0" };
  }

  /** The person plays or hands the body to the elite bot (arena phase only). */
  setAfk(wallet: string, on: boolean): boolean {
    if (this.ended || this.stage !== "arena") return false;
    return this.arena.setAfk(wallet, on);
  }

  /** The person is back: they steer again, with a few seconds of protection. */
  back(wallet: string): boolean {
    if (this.ended || this.stage !== "arena") return false;
    return this.arena.back(wallet);
  }

  setInput(wallet: string, dx: number, dy: number, boost: boolean) {
    if (this.ended) return;
    if (this.stage === "arena") {
      this.arena.setInput(wallet, dx, dy, boost);
      return;
    }
    const f = this.fplayers.get(wallet);
    if (!f || f.bot) return;
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      f.dx = dx;
      f.dy = dy;
      f.moved = true;
    }
    f.nitro = !!boost;
  }

  /** The proof written to the chain at settlement: revealed seed, snapshot hash and the root of every replay. */
  proof(seedReveal: Uint8Array, blockhash: Uint8Array): { seedReveal: Uint8Array; blockhash: Uint8Array; snapshotHash: Uint8Array; replayRoot: Uint8Array } {
    const h = createHash("sha256");
    for (const w of [...this.replays.keys()].sort()) h.update(w).update(this.replays.get(w)!.hash, "hex");
    return {
      seedReveal,
      blockhash,
      snapshotHash: this.frenzyOpts ? Buffer.from(this.frenzyOpts.snapshot.hash, "hex") : new Uint8Array(32),
      replayRoot: h.digest(),
    };
  }

  /** The size and hash of the arena match record, for the result of a practice match. */
  arenaRecordInfo(): { hash: string; bytes: number; entries: number } | null {
    const r = this.replays.get("arena");
    return r ? { hash: r.hash, bytes: r.bytes.length, entries: this.arena.inputLog.length } : null;
  }

  replayOf(wallet: string): Uint8Array | null {
    return this.replays.get(wallet)?.bytes ?? null;
  }

  replayIndex(): { w: string; hash: string; bytes: number }[] {
    return [...this.replays].map(([w, r]) => ({ w, hash: r.hash, bytes: r.bytes.length }));
  }

  /** The skin each player wears in this match (wallet -> skin id), for the screens and for the archived replay. */
  skinsMap(): Record<string, string> {
    return Object.fromEntries(this.players.filter((p) => p.skin).map((p) => [p.w, p.skin as string]));
  }

  begin() {
    const wait = Math.max(0, this.startsAt - Date.now());
    setTimeout(() => {
      if (this.ended || this.timer) return;
      this.last = Date.now();
      this.flast = this.last;
      this.timer = setInterval(() => this.loop(), 25);
    }, wait);
  }

  /** One fixed step of the minute for every player; the input of the tick is what is recorded. */
  private frenzyStep() {
    const map = this.fmap!;
    this.ftick++;
    const taken: Record<string, { taken: number[]; back: number[]; hit: boolean }> = {};
    for (const [w, f] of this.fplayers) {
      if (f.bot) {
        if (this.frenzyLevel) {
          const seed = (f.jitter + 64) * 13 + w.charCodeAt(w.length - 1);
          if ((this.ftick + seed) % FRENZY_LEVELS[this.frenzyLevel].every === 0 || this.ftick === 1) {
            const a = frenzyBrainLevel(map, f.st, this.frenzyLevel, seed);
            f.st.angle = a.angle;
            f.st.nitro = a.nitro;
          }
        } else {
          if (this.ftick % 4 === 1) {
            const a = frenzyBrain(map, f.st, f.jitter);
            f.st.angle = a.angle;
          }
          f.st.nitro = false;
        }
      } else {
        f.st.angle = angleByte(f.dx, f.dy);
        f.st.nitro = f.nitro;
      }
      f.st.hold = !f.moved;
      f.rec.note(this.ftick, f.st.angle, f.st.nitro, f.st.hold);
      const o = stepPlayer(map, f.st);
      taken[w] = o;
    }
    // Compact top 5 by mass, shared by all.
    const order = [...this.players].map((p) => ({ n: p.n, w: p.w, m: this.fplayers.get(p.w)!.st.m })).sort((a, b) => b.m - a.m || (a.w < b.w ? -1 : 1));
    const top = order.slice(0, 5).map((o) => [o.n, Math.round(o.m * 10) / 10]);
    const timeLeftMs = Math.max(0, FRENZY.ms - Math.round((this.ftick / FRENZY.tickRate) * 1000));
    for (const [w, f] of this.fplayers) {
      if (f.bot) continue;
      const o = taken[w];
      this.onSnap({
        t: "fsnap",
        to: w,
        roomId: this.roomId,
        tick: this.ftick,
        timeLeftMs,
        you: { x: Math.round(f.st.x * 10) / 10, y: Math.round(f.st.y * 10) / 10, m: Math.round(f.st.m * 10) / 10, stun: f.st.stun, h: f.st.angle },
        taken: o.taken,
        back: o.back,
        hit: o.hit,
        top,
        rank: order.findIndex((x) => x.w === w) + 1,
      });
    }
  }

  /** Ends the minute: freezes the replays and hands each player's mass to the arena. */
  private frenzyDone() {
    for (const [w, f] of this.fplayers) {
      const bytes = encodeReplay(this.seed, this.frenzyOpts!.snapshot.hash, f.rec.entries);
      this.replays.set(w, { bytes, hash: replayHash(bytes) });
      const p = this.arena.player(w);
      if (p) {
        p.m = carriedMass(f.st.m);
        p.peak = p.m;
        this.arenaStartMass.set(w, p.m);
      }
      if (!f.bot) {
        this.onSnap({ t: "fend", to: w, roomId: this.roomId, mass: Math.round(f.st.m * 10) / 10, carried: carriedMass(f.st.m), eaten: f.st.eaten, replay: this.replays.get(w)!.hash });
      }
    }
    this.stage = "gap";
  }

  private loop() {
    try {
      this.loopInner();
    } catch (e: any) {
      // A bug in one tick must be visible, not a silent stall of the whole room.
      const now = Date.now();
      if (now - this.lastErrAt > 5000) {
        this.lastErrAt = now;
        console.log(JSON.stringify({ at: new Date().toISOString(), event: "match_loop_error", roomId: this.roomId, stage: this.stage, error: String(e?.stack ?? e).slice(0, 600) }));
      }
    }
  }
  private lastErrAt = 0;

  private loopInner() {
    const now = Date.now();
    if (this.stage === "frenzy") {
      this.facc += Math.min(0.25, (now - this.flast) / 1000);
      this.flast = now;
      let n = 0;
      while (this.facc >= STEP && n < 5 && this.ftick < FRENZY.ticks) {
        this.frenzyStep();
        this.facc -= STEP;
        n++;
      }
      if (this.ftick >= FRENZY.ticks) this.frenzyDone();
      return;
    }
    if (this.stage === "gap") {
      if (now < this.arenaStartsAt) return;
      this.stage = "arena";
      this.last = now;
      this.acc = 0;
      return;
    }
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    let steps = 0;
    while (this.acc >= STEP && steps < 5 && !this.ended) {
      this.botPowers();
      const ev = this.arena.step(STEP, arenaBrain);
      this.pendingEaten.push(...ev.eatenOrbs);
      this.pendingNew.push(...ev.newOrbs);
      if (ev.fuses) this.pendingFuses.push(...ev.fuses);
      for (const d of ev.deaths) {
        const rank = this.arena.ranking().find((r) => r.w === d.w)?.rank ?? 0;
        this.pendingEvents.push({ k: "death", w: d.w, by: d.by, rank });
      }
      this.acc -= STEP;
      steps++;
      this.tick++;
      this.snap();
      if (this.arena.finished() || this.arena.time * 1000 >= this.matchMs) {
        this.finish();
        return;
      }
    }
  }

  /** The current circle, the phase and, while a new circle is announced or moving, the circle it is going to. */
  private zoneMsg() {
    const z = this.arena.zoneNow();
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const msg: any = { cx: r1(z.cx), cy: r1(z.cy), r: r1(z.r), phase: z.phase, state: z.state, inMs: Math.round(z.inSeconds * 1000) };
    if (z.target) msg.target = { cx: Math.round(z.target.cx), cy: Math.round(z.target.cy), r: z.target.r };
    return msg;
  }

  private snap() {
    const a = this.arena;
    setRules(a.rules);
    this.onSnap({
      t: "snap",
      roomId: this.roomId,
      tick: this.tick,
      timeLeftMs: Math.max(0, Math.round(this.matchMs - a.time * 1000)),
      zone: this.zoneMsg(),
      players: a.players.map((p) => ({
        w: p.w,
        n: p.n,
        role: p.role,
        bot: p.bot,
        alive: p.alive,
        zout: p.alive && Math.hypot(p.x - a.zoneNow().cx, p.y - a.zoneNow().cy) > a.zoneNow().r,
        prot: p.alive && p.protectUntil > a.time,
        h: Math.round(p.heading * 100) / 100,
        m: Math.round(p.m * 10) / 10,
        ...(this.bagPool || a.cash ? { bag: p.bag ?? 0 } : {}),
        ...(a.cash ? { en: a.entryOf(p), qk: p.qk ?? 0, ...(p.boostSpill ? { bs: p.boostSpill } : {}) } : {}),
        ...(p.cashoutAt !== undefined ? { co: Math.round((a.time - p.cashoutAt) * 10) / 10 } : {}),
        ...(p.cashoutAt !== undefined && p.cashedBag !== undefined ? { cb: p.cashedBag } : {}),
        ...(p.alive && (p.shieldUntil ?? 0) > a.time ? { sh: 1 } : {}),
        r: Math.round(bodyRadius(p.m) * 10) / 10,
        head: [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10],
        // A long arena with many bodies sends every other point of a body: half the bytes, the same line on screen.
        body: p.alive ? bodyPoints(p).slice(1).filter((_, k) => !a.survival || k % 2 === 0).map((q) => [Math.round(q[0]), Math.round(q[1])]) : [],
      })),
      // Traps on the map: kind, owner, the beam ends or the puddle center and radius, and seconds left.
      ...(a.traps.length ? { traps: a.traps.map((t) => ({ k: t.kind, o: t.owner, x: Math.round(t.x), y: Math.round(t.y), x2: Math.round(t.x2), y2: Math.round(t.y2), r: t.r, s: Math.round((t.until - a.time) * 10) / 10 })) } : {}),
      // Survival: the map follows the leader, so its square travels with every snapshot.
      ...(a.survival ? { world: { x0: Math.round(ARENA.w / 2 - a.mapR), y0: Math.round(ARENA.h / 2 - a.mapR), w: Math.round(a.mapR * 2), h: Math.round(a.mapR * 2) } } : {}),
      // Rules 6: the boss, where its cycle is (calm, warn, open) and the seconds to the next change.
      ...(a.rules >= 6 ? { boss: this.bossMsg() } : {}),
      ...(a.pops.length ? { pops: a.pops.splice(0) } : {}),
      // Rooms with money: the SOL lying free on the map and the SOL in the bags of the players alive, right now (lamports).
      ...(a.cash || this.bagPool ? { sol: { free: a.orbs.reduce((n, o) => n + (o.l ?? 0), 0), held: a.players.reduce((n, p) => n + (p.alive ? p.bag ?? 0 : 0) + (p.boostSpill ?? 0), 0) } } : {}),
      ...(a.cash ? { cashInfo: { in: a.cashIn, n: a.cashEntries, house: a.cashHouse, paid: a.cashPaid, outs: a.cashOuts, kills: a.cashKills, cut: a.cashCut, left: a.cashLeft } } : {}),
      // Rules 7: the zone holds still for the last three, and how long it still does.
      ...(a.freezeLeft() > 0 ? { freeze: Math.ceil(a.freezeLeft()) } : {}),
      eatenOrbs: this.pendingEaten,
      newOrbs: this.pendingNew.map((o) => orbMsg(o, this.arena.cash)),
      events: this.pendingEvents,
      ...(this.pendingFuses.length ? { fuses: this.pendingFuses } : {}),
      // Survival: seconds to the next airdrop, and where one just landed (so the page can announce it).
      ...(a.survival ? { dropIn: Math.round(a.nextDropIn()) } : {}),
      ...(a.survival && a.dropAt && a.time - a.dropAt.t < 0.06 ? { drop: { x: a.dropAt.x, y: a.dropAt.y } } : {}),
    });
    this.pendingEaten = [];
    this.pendingNew = [];
    this.pendingEvents = [];
    this.pendingFuses = [];
  }

  private bossMsg() {
    const b = this.arena.boss();
    if (!b) return null;
    const ph = this.arena.bossPhase();
    return { w: b.w, st: ph.state, in: Math.ceil(ph.inS) };
  }

  /**
   * Rules 6: the bots use the powers too, through the same queue as a person (so the record replays them). A small bot near the
   * boss while it is exposed may blow up on it (one kamikaze every 8 seconds in the whole arena); a bot that is the boss raises
   * its shield when it is exposed and is being bitten.
   */
  private lastKamikaze = -99;
  private botPowers() {
    const a = this.arena;
    if (a.rules < 6 || a.cash) return;
    const b = a.boss();
    if (!b) return;
    const ph = a.bossPhase();
    if (ph.state !== "open") return;
    const bi = a.players.indexOf(b);
    if (b.bot && !b.afk && (b.shieldReady ?? 0) <= a.time && this.tick % 7 === 0) a.queueTrap(bi, POWER_SHIELD);
    if (a.time - this.lastKamikaze < 8) return;
    for (let i = 0; i < a.players.length; i++) {
      const p = a.players[i];
      if (!p.alive || !p.bot || p === b || p.m * 8 > b.m || (this.tick + i) % 11 !== 0) continue;
      if (a.queueTrap(i, POWER_KAMIKAZE)) { this.lastKamikaze = a.time; break; }
    }
  }

  /** Stops the loop without reporting a result (the player left). */
  /** True while the match is paused (a live arena nobody is in): no step runs, everything stays exactly as it was. */
  get paused(): boolean { return this.timer === undefined && !this.ended; }
  /** Pauses the match: the clock stops, nothing moves, nothing is spent. */
  pause() {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  /** Goes on from where it paused (the time asleep is not played). */
  resume() {
    if (this.ended || this.timer) return;
    this.last = Date.now();
    this.flast = this.last;
    this.acc = 0;
    this.timer = setInterval(() => this.loop(), 25);
  }

  stop() {
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Freezes the record of the whole arena phase: its hash goes into the replay root that the closing transaction logs. */
  private sealArenaRecord() {
    const start = this.arenaStartMass;
    const bytes = encodeArenaReplay(
      this.seed, this.matchMs, this.shrinkStartMs,
      this.players.map((p) => ({ w: p.w, n: p.n, role: p.role, bot: p.bot, m: start.get(p.w) ?? ARENA.startMass })),
      this.arena.inputLog,
      this.arena.rules,
      this.bagPool,
      this.arena.bagFee,
    );
    this.replays.set("arena", { bytes, hash: arenaReplayHash(bytes) });
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    this.sealArenaRecord();
    this.onEnd({ mode: this.mode, ranking: this.arena.ranking() });
  }

  /** Test helper: run the whole match instantly. */
  runToEnd(): MatchResult {
    while (!this.arena.finished() && this.arena.time * 1000 < this.matchMs) this.arena.step(STEP, arenaBrain);
    this.ended = true;
    return { mode: this.mode, ranking: this.arena.ranking() };
  }
}
