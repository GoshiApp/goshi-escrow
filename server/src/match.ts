import { createHash } from "node:crypto";
import { arenaReplayHash, encodeArenaReplay } from "./game/arena-replay.js";
import { ARENA, Arena, ZONE_RADII, arenaBrain, bodyPoints, bodyRadius, type Orb, type Role } from "./game/arena.js";
import {
  FRENZY, Recorder, angleByte, buildMap, carriedMass, encodeReplay, frenzyBrain, newPlayer, replayHash, stepPlayer,
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
export class Match {
  readonly arena: Arena;
  /** Start of the arena phase (a minute plus a short gap after `startsAt` when there is a frenzy). */
  readonly arenaStartsAt: number;
  private stage: "frenzy" | "gap" | "arena";
  private fmap?: FrenzyMap;
  private fplayers = new Map<string, { st: FrenzyPlayer; rec: Recorder; dx: number; dy: number; nitro: boolean; bot: boolean; jitter: number; moved: boolean }>();
  private ftick = 0;
  private facc = 0;
  private flast = 0;
  private replays = new Map<string, { bytes: Uint8Array; hash: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private acc = 0;
  private last = 0;
  private pendingEaten: number[] = [];
  private pendingNew: Orb[] = [];
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
  ) {
    this.matchMs = matchMs;
    this.arena = new Arena(seed, players, { matchMs, shrinkStartMs });
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
      orbs: this.arena.orbs.map((o) => ({ id: o.id, x: o.x, y: o.y, v: o.v })),
      you,
      roles: this.roles(),
      skins: Object.fromEntries(this.players.filter((p) => p.skin).map((p) => [p.w, p.skin])),
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

  begin() {
    const wait = Math.max(0, this.startsAt - Date.now());
    setTimeout(() => {
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
        if (this.ftick % 4 === 1) {
          const a = frenzyBrain(map, f.st, f.jitter);
          f.st.angle = a.angle;
        }
        f.st.nitro = false;
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
      const ev = this.arena.step(STEP, arenaBrain);
      this.pendingEaten.push(...ev.eatenOrbs);
      this.pendingNew.push(...ev.newOrbs);
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
        r: Math.round(bodyRadius(p.m) * 10) / 10,
        head: [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10],
        body: p.alive ? bodyPoints(p).slice(1).map((q) => [Math.round(q[0]), Math.round(q[1])]) : [],
      })),
      eatenOrbs: this.pendingEaten,
      newOrbs: this.pendingNew.map((o) => ({ id: o.id, x: o.x, y: o.y, v: o.v })),
      events: this.pendingEvents,
    });
    this.pendingEaten = [];
    this.pendingNew = [];
    this.pendingEvents = [];
  }

  /** Stops the loop without reporting a result (the player left). */
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
