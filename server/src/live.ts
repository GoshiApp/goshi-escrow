// The live arena: one survival arena that is always running, with 20 places. Bots with fixed addresses fill every place; a person
// who enters takes the place of a bot, and when it is over (or the person leaves) the bot comes back. When all the places hold
// people the next ones wait in a queue, in order. Nothing here is simulated: the queue and the counts are the real ones.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { config, log } from "./config.js";
import { takeSnapshot } from "./snapshot.js";
import { Match } from "./match.js";
import { attachPaySig, saveClip, type VarClip, type VarFrame } from "./var-clips.js";
import { botCashOut, botEntry, checkEntry, keepVaultAlive, payOut, useTicket, vaultAddress } from "./cash-vault.js";
import { POWER_CASHOUT, setBotDifficulty, type Player, type TrapKind } from "./game/arena.js";
import type { Client } from "./rooms.js";
import { FOUNDER_SKINS, OPEN_SKINS, isFounder, isKnownSkin } from "./game/skins.js";

export const LIVE_PLACES = 20;
/**
 * The cash arenas of the test network, one per entry: each has its own map, pot, bots and VAR. The entry is fixed per arena, and
 * how many of its bots pay a real entry (so the SOL locked on the maps stays within what the server key holds on devnet).
 */
export const LIVE_TIERS = [
  { id: "a3", entry: 3_000_000, paidBots: 20 },
  { id: "a10", entry: 10_000_000, paidBots: 10 },
  { id: "a25", entry: 25_000_000, paidBots: 6 },
] as const;
export type LiveTier = (typeof LIVE_TIERS)[number];
/** The project's own wallet: only a connection that signed in with it (verified by the server) gets the eating power. */
const CEO_WALLET = "2kLcGpwnpz5eroGRW2kWqCdizmPEGDLTb5JAce9u2GJ9";
/** Viewers of the live arena: a whole server, and one address (a script cannot pull the pictures over and over). */
const MAX_SPECTATORS = 80;
const MAX_PER_ADDRESS = 8;

const short = (w: string) => `${w.slice(0, 4)}..${w.slice(-4)}`;
/** Fixed addresses for the bots: derived from a seed that is in the open, so they are the same after every restart. */
function botAddress(i: number): string {
  const seed = crypto.createHash("sha256").update(`goshi-live-bot-${i}`).digest();
  return Keypair.fromSeed(new Uint8Array(seed)).publicKey.toBase58();
}

interface Slot { botW: string; botN: string; client: Client | null; humanW: string }

export class LiveArena {
  readonly match: Match;
  private slots: Slot[];
  private subs = new Set<Client>();
  /** Wallet (or temporary id) -> the skin that person wears, so everybody sees the skins of the others. */
  private skins = new Map<string, string>();
  private queue: { c: Client; name: string; wallet: string | null }[] = [];
  private statusTimer: ReturnType<typeof setInterval>;

  constructor(private send: (c: Client, msg: object) => void, readonly tier: LiveTier = LIVE_TIERS[0]) {
    // The first arena keeps the bot addresses it always had; the others get their own.
    const base = LIVE_TIERS.findIndex((t) => t.id === tier.id) * 100;
    this.slots = Array.from({ length: LIVE_PLACES }, (_, i) => {
      const w = botAddress(base + i);
      return { botW: w, botN: short(w), client: null, humanW: "" };
    });
    const roster = this.slots.map((s) => ({ w: s.botW, n: s.botN, role: "paid" as const, bot: true }));
    const seed = crypto.randomBytes(4).readUInt32BE(0);
    const SIX_HOURS = 6 * 3600_000;
    this.match = new Match(tier.id === LIVE_TIERS[0].id ? "live-arena" : `live-arena-${tier.id}`, "royale", roster, seed, SIX_HOURS, Date.now() + 500, (snap) => this.onSnap(snap), () => {
      // It never ends on its own; if it does, the server starts it again.
      log("live_arena_ended", {});
    }, SIX_HOURS, undefined, true, 0);
    setBotDifficulty(this.match.arena, "insane");
    // Twenty bots in each of several arenas on one CPU: each bot decides every third step (about seven times a second).
    this.match.arena.brainEvery = 3;
    // The test network plays the cash arena: entries fall as coins, no body is immune, cashing out takes three eliminations.
    if (config.cluster === "devnet") {
      // Nothing without value exists here: the map holds only the coins of the entries (empty when nobody has entered), no
      // free food, no showers and no big orbs; a death drops only its bag.
      const a = this.match.arena;
      a.cash = true;
      a.cashMin = tier.entry;
      a.bagMode = true;
      a.orbs.length = 0;
      // The vault on chain only where the test bots run (the deployed test server, not the unit tests).
      if (config.devBots && tier.id === LIVE_TIERS[0].id) { void keepVaultAlive(); setInterval(() => void keepVaultAlive(), 10 * 60_000).unref(); }
    }
    // The bots' skins (given by the match) are told to everybody like the people's own.
    for (const r of roster as { w: string; skin?: string }[]) if (r.skin) this.skins.set(r.w, r.skin);
    this.match.begin();
    // Its coins are worth what they are worth on the market: the prices of the moment it starts (from the next coin on).
    void takeSnapshot().then((s) => { this.match.arena.coinPrices = { ...s.usd }; }).catch(() => undefined);
    this.statusTimer = setInterval(() => { this.broadcastStatus(); this.sleepIfEmpty(); }, 4000);
    log("live_arena_started", { places: LIVE_PLACES });
  }

  /**
   * An arena with nobody in it (no viewer, no player) for 20 s goes to sleep: its match pauses with everything as it was (bodies,
   * coins, bags, the pot), so it costs nothing. The first person who opens it wakes it at once.
   */
  private emptySince = 0;
  private sleepIfEmpty(): void {
    if (this.subs.size > 0) { this.emptySince = 0; return; }
    if (!this.emptySince) this.emptySince = Date.now();
    if (Date.now() - this.emptySince > 20_000 && !this.match.paused) { this.match.pause(); log("live_arena_sleep", { arena: this.tier.id }); }
  }
  private wake(): void {
    this.emptySince = 0;
    if (this.match.paused) { this.match.resume(); log("live_arena_wake", { arena: this.tier.id }); }
  }

  stop() {
    clearInterval(this.statusTimer);
    this.match.stop();
  }

  private player(i: number): Player | undefined {
    return this.match.arena.players[i];
  }

  private humans(): number {
    return this.slots.filter((s) => s.client).length;
  }

  /** The addresses of the bots, so the pages can mark them as bots. */
  botAddresses(): string[] {
    return this.slots.map((s) => s.botW);
  }

  stats() {
    return { arena: this.tier.id, places: LIVE_PLACES, humans: this.humans(), waiting: this.queue.length, watching: this.subs.size, ...(this.match.arena.cash ? { cash: { price: this.cashPrice(), vault: vaultAddress } } : {}) };
  }

  // ------------------------------------------------------------------ what clients hear

  private frame = 0;
  /** What the viewers missed in the picture they skipped: the orbs eaten and dropped, to be sent with the next one. */
  private skipped: { eaten: number[]; fresh: { id: number }[] } | null = null;

  /** VAR: the last ten seconds as the server played them, one compact picture per snapshot. */
  private varFrames: VarFrame[] = [];
  private varNames = new Map<string, string>();
  private onSnap(snap: any) {
    // The VAR only records where people play (its clips are only of plays with a person in them).
    if (this.match.arena.cash) { if (this.humans() || this.pendingClips.length) this.recordVar(snap); else if (this.varFrames.length) this.varFrames = []; this.cashBots(snap); }
    if (this.credits.size) this.payCredits();
    // Nobody watching this arena: nothing to encode or send (the game itself goes on).
    if (this.subs.size === 0) return;
    // Every five seconds the full list of coins that exist, so any screen drops a coin it still draws but is gone.
    if (this.frame % 100 === 0) snap.orbIds = this.match.arena.orbs.map((o) => o.id);
    const text = JSON.stringify(snap);
    // Who only watches gets every other picture (10 a second, smoothed on the page); who plays gets all of them. A picture with an
    // elimination or a coin shower always goes to everybody. The orbs of a skipped picture travel with the next one, so the map of
    // a viewer never drifts from the real one.
    const half = (this.frame++ & 1) === 1 && (snap.events?.length ?? 0) === 0 && !snap.drop && !this.skipped;
    let viewerText = text;
    if (half) {
      this.skipped = { eaten: [...(snap.eatenOrbs ?? [])], fresh: [...(snap.newOrbs ?? [])] };
    } else if (this.skipped) {
      // A coin that was born and eaten inside the two pictures is left out of both lists (the viewer never knew it), and a coin
      // born in the skipped picture is only told when it still exists: no viewer is left drawing a coin that is gone.
      const eatenAll = new Set<number>([...this.skipped.eaten, ...(snap.eatenOrbs ?? [])]);
      const freshBefore = new Set(this.skipped.fresh.map((o) => o.id));
      viewerText = JSON.stringify({
        ...snap,
        eatenOrbs: [...eatenAll].filter((id) => !freshBefore.has(id)),
        newOrbs: [...this.skipped.fresh.filter((o) => !eatenAll.has(o.id)), ...(snap.newOrbs ?? [])],
      });
      this.skipped = null;
    }
    for (const c of this.subs) {
      const watching = c.live?.slot === null;
      if (half && watching) continue;
      // A slow connection skips pictures instead of piling them up: it stays current rather than falling behind.
      if (c.ws.readyState !== 1 || c.ws.bufferedAmount > 600_000) continue;
      try { c.ws.send(watching ? viewerText : text); } catch { /* the close handler cleans up */ }
    }
    for (const ev of snap.events ?? []) {
      if (ev.k !== "death") continue;
      const i = this.slots.findIndex((s) => s.client && s.humanW === ev.w);
      if (i >= 0) this.humanDied(i);
    }
  }

  private status(c: Client) {
    const l = c.live;
    const queued = this.queue.findIndex((q) => q.c === c);
    this.send(c, {
      t: "live", ...this.stats(),
      state: l && l.slot !== null ? "playing" : queued >= 0 ? "queued" : l?.dead ? "dead" : "watching",
      ...(l && l.slot !== null ? { you: this.slots[l.slot].humanW } : {}),
      ...(queued >= 0 ? { pos: queued + 1 } : {}),
    });
  }

  private broadcastStatus() {
    for (const c of this.subs) this.status(c);
  }

  // ------------------------------------------------------------------ people

  watch(c: Client, player = false): boolean {
    this.wake();
    if (!this.subs.has(c)) {
      // The limits are for people who only watch; whoever takes a place is always let in (the places are the limit).
      if (!player && this.subs.size >= MAX_SPECTATORS) return false;
      if (!player && c.ip && [...this.subs].filter((x) => x.ip === c.ip && x.live?.slot == null).length >= MAX_PER_ADDRESS) return false;
      this.subs.add(c);
    }
    c.live ??= { spectator: `spec_${crypto.randomBytes(5).toString("hex")}`, slot: null };
    this.send(c, { ...this.match.startMsg(c.live.spectator), practice: true, live: true });
    this.send(c, { t: "skins", map: Object.fromEntries(this.skins) });
    this.status(c);
    return true;
  }

  join(c: Client, name: string, wallet: string | null, skin: string | null = null, entrySig: string | null = null): void {
    if (!this.subs.has(c)) this.watch(c, true);
    if (c.live!.slot !== null || this.queue.some((q) => q.c === c)) return this.status(c);
    c.live!.dead = false;
    c.live!.skin = this.allowedSkin(c, skin);
    c.live!.wallet = wallet;
    c.live!.entrySig = entrySig;
    // A ticket only counts for the wallet that signed in on this connection: without that sign-in nothing is taken and the
    // ticket stays unused (the page asks to sign in and tries again).
    if (this.match.arena.cash && entrySig && !c.wallet) {
      log("cash_join_refused", { arena: this.tier.id, why: "sign_in", sig: entrySig.slice(0, 12) });
      c.live!.entrySig = null;
      this.send(c, { t: "cashEntry", ok: false, why: "sign_in", sig: entrySig });
      return this.status(c);
    }
    if (this.match.arena.cash) log("cash_join", { arena: this.tier.id, wallet: c.wallet ?? null, ticket: entrySig ? entrySig.slice(0, 12) : null });
    const slot = this.freeSlot();
    if (slot < 0) {
      this.queue.push({ c, name, wallet });
      return this.status(c);
    }
    this.seat(slot, c, name, wallet);
  }

  leave(c: Client): void {
    this.queue = this.queue.filter((q) => q.c !== c);
    const l = c.live;
    if (l) l.dead = false;
    if (l && l.slot !== null) this.vacate(l.slot);
    this.status(c);
  }

  /** The connection closed: whatever it held is freed. */
  drop(c: Client): void {
    this.subs.delete(c);
    this.queue = this.queue.filter((q) => q.c !== c);
    const l = c.live;
    if (l && l.slot !== null) this.vacate(l.slot);
    c.live = undefined;
  }

  /** The skin a person may wear here: an open skin, or the team's skin for the verified team wallet. */
  private allowedSkin(c: Client, id: string | null): string | null {
    if (!id) return null;
    // A plain goshi color ("hue:0" to "hue:7") is open to everybody.
    if (/^hue:[0-7]$/.test(id)) return id;
    if (OPEN_SKINS.includes(id)) return id;
    // The test network opens the holder skins too, so they can be tried.
    if (config.cluster === "devnet" && isKnownSkin(id) && !FOUNDER_SKINS.includes(id)) return id;
    if (FOUNDER_SKINS.includes(id) && isFounder(c.wallet)) return id;
    return null;
  }

  private broadcastSkins(): void {
    const text = JSON.stringify({ t: "skins", map: Object.fromEntries(this.skins) });
    for (const c of this.subs) {
      if (c.ws.readyState === 1) { try { c.ws.send(text); } catch { /* the close handler cleans up */ } }
    }
  }

  /** AFK (the computer plays the body as an elite bot) is for the verified team wallet only. */
  afk(c: Client, on: boolean): void {
    if (c.wallet !== CEO_WALLET) return;
    const l = c.live;
    if (!l || l.slot === null) return;
    this.match.setAfk(this.slots[l.slot].humanW, on);
  }

  /**
   * Bought length: the payment was checked on chain by the caller. The body of this place grows by one step now; when it
   * cannot (no body, a dead one, or one already at the maximum) the step is kept as a credit and given to the next life.
   */
  /** Waiting length credits by the wallet that paid them: a reload or a new tab with the same wallet keeps them. */
  private credits = new Map<string, number>();
  growLength(c: Client, payer: string): number | "credit" {
    const got = this.tryGrow(c);
    if (typeof got === "number") return got;
    this.credits.set(payer, (this.credits.get(payer) ?? 0) + 1);
    return "credit";
  }
  private tryGrow(c: Client): number | "max" | null {
    const l = c.live;
    if (!l || l.slot === null) return null;
    return this.match.growLength(this.slots[l.slot].humanW);
  }
  /** Gives waiting credits to bodies that are alive again (checked with every picture, it is a tiny map). */
  private payCredits(): void {
    for (const c of this.subs) {
      const w = c.live?.wallet;
      const n = w ? this.credits.get(w) ?? 0 : 0;
      if (!w || n <= 0) continue;
      const got = this.tryGrow(c);
      if (typeof got !== "number") continue;
      if (n <= 1) this.credits.delete(w); else this.credits.set(w, n - 1);
      try { c.ws.send(JSON.stringify({ t: "lengthOk", bonus: got, fromCredit: true })); } catch { /* closed */ }
    }
  }

  /** A free trap in the live arena (it waits a few seconds between two). */
  trap(c: Client, kind: TrapKind): ReturnType<Match["trap"]> | null {
    const l = c.live;
    if (!l || l.slot === null) return null;
    return this.match.trap(this.slots[l.slot].humanW, kind, true);
  }

  input(c: Client, dx: number, dy: number, boost: boolean): void {
    const l = c.live;
    if (!l || l.slot === null) return;
    this.match.setInput(this.slots[l.slot].humanW, dx, dy, boost);
  }

  // ------------------------------------------------------------------ places

  /** A place held by a bot: a dead body first, otherwise the lightest bot. */
  private freeSlot(): number {
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].client) continue;
      const p = this.player(i);
      if (!p) continue;
      const score = p.alive ? p.m : -1;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  private seat(i: number, c: Client, name: string, wallet: string | null): void {
    const s = this.slots[i];
    const p = this.player(i)!;
    const taken = new Set(this.slots.map((x) => x.humanW).filter(Boolean));
    // Only a wallet that signed in on this connection counts as that wallet: the address a page claims is not trusted.
    const verified = c.wallet && !taken.has(c.wallet) ? c.wallet : null;
    const w = verified ?? `you_${crypto.randomBytes(6).toString("hex")}`;
    // In the live arenas everybody is shown by the address that plays (what the chain shows), never a chosen name.
    const label = verified ? short(verified) : short(w.replace("you_", ""));
    s.client = c;
    s.humanW = w;
    this.match.arena.claim(p, w, label);
    const skin = c.live!.skin ?? null;
    if (skin) this.skins.set(w, skin);
    this.broadcastSkins();
    p.ceo = c.wallet === CEO_WALLET;
    p.afk = false;
    c.live!.slot = i;
    // Cash arena (test): every person enters with the smallest amount, in test money for now.
    // The entry is the average bag of the paying players alive (never below the minimum), so a newcomer pays what the arena is
    // playing for.
    // Cash arena (devnet): a signed in wallet that paid its entry to the vault enters with what really arrived, once the transfer
    // is checked on chain; without a payment (a guest) it plays for nothing and cannot cash out.
    const sig = c.live!.entrySig;
    if (this.match.arena.cash && sig && verified) {
      c.live!.entrySig = null;
      void checkEntry(sig, verified, this.tier.entry).then((r) => {
        log("cash_entry_checked", { arena: this.tier.id, wallet: verified, ok: r.ok, why: r.ok ? null : r.why, seated: s.humanW === w });
        if (s.humanW !== w) return;
        if (r.ok) {
          useTicket(sig, verified, r.lamports);
          this.match.cashEnter(w, r.lamports);
          this.send(c, { t: "cashEntry", ok: true, lamports: r.lamports, sig });
        } else this.send(c, { t: "cashEntry", ok: false, why: r.why, sig });
      });
    }
    this.status(c);
  }

  /** The slot goes back to its bot, and the next person waiting takes a place. */
  private vacate(i: number): void {
    const s = this.slots[i];
    const p = this.player(i);
    const c = s.client;
    if (s.humanW) this.skins.delete(s.humanW);
    s.client = null;
    s.humanW = "";
    this.broadcastSkins();
    if (p && p.alive && this.match.arena.cash && c) this.match.arena.cashLeft++;
    if (p) { p.ceo = false; p.afk = false; this.match.arena.release(p, s.botW, s.botN); }
    if (c?.live) c.live.slot = null;
    this.promote();
  }

  private varTick = 0;
  /** The entry asked now: the average bag of the paying players alive, never below the minimum (lamports). */
  cashPrice(): number {
    return this.tier.entry;
  }

  /** What the list of arenas shows: entry, people and bots, and the SOL in play (on the map and in the bags). */
  summary() {
    const a = this.match.arena;
    const free = a.orbs.reduce((n, o) => n + (o.l ?? 0), 0), held = a.players.reduce((n, p) => n + (p.alive ? p.bag ?? 0 : 0) + (p.boostSpill ?? 0), 0);
    return { id: this.tier.id, entry: this.tier.entry, places: LIVE_PLACES, humans: this.humans(), waiting: this.queue.length, watching: this.subs.size, pool: free + held, entries: a.cashEntries, outs: a.cashOuts };
  }

  /**
   * Cash arena bots, while at least one person is playing: a bot without an entry pays one from its own devnet wallet to the
   * vault (then its coins fall on the map), and a bot that cashed out is paid from the vault. Nobody watching, nothing is spent.
   */
  private botPending = new Set<number>();
  private cashBots(snap: any): void {
    const a = this.match.arena;
    // The bots play for real all the time (not only while people watch): they pay their entries, hunt, and cash out.
    if (!config.devBots) return;
    this.slots.forEach((sl, i) => {
      const p = this.player(i);
      if (!p || sl.client || !p.bot || !p.alive || p.entry !== undefined || this.botPending.has(i) || i >= this.tier.paidBots) return;
      this.botPending.add(i);
      const entry = this.tier.entry;
      void botEntry(i, entry, this.tier.id).then((sig) => {
        this.botPending.delete(i);
        const q = this.player(i);
        if (sig && q && q.bot && q.alive && q.entry === undefined) this.match.cashEnter(q.w, entry);
      });
    });
    // A bot that doubled its entry and has its three eliminations cashes out, like a person would.
    this.slots.forEach((sl, i) => {
      const p = this.player(i);
      if (p && !sl.client && p.bot && p.alive && p.entry && (p.qk ?? 0) >= 3 && (p.bag ?? 0) >= p.entry * (1.2 + ((i * 37) % 10) / 10) && p.cashoutAt === undefined) a.queueTrap(i, POWER_CASHOUT);
    });
    for (const ev of snap.events ?? []) {
      if (ev.k !== "death") continue;
      const i = this.slots.findIndex((sl) => sl.botW === ev.w && !sl.client);
      const p = i >= 0 ? this.player(i) : undefined;
      if (p && p.cashedBag) { const bag = p.cashedBag; p.cashedBag = undefined; botCashOut(i, bag, this.tier.id); }
    }
  }

  /** Clips waiting for the two seconds after the death (the coins bursting and falling), then saved. */
  private pendingClips: { meta: Omit<VarClip, "hash" | "frames" | "names" | "skins" | "id" | "at" | "cluster">; deathAt: number; c: Client | null }[] = [];
  private flushClips(): void {
    const now = Date.now();
    while (this.pendingClips.length && now - this.pendingClips[0].deathAt >= 2000) {
      const pc = this.pendingClips.shift()!;
      // The clip: the eight seconds before the death or the cash out, and the two after it.
      const frames = this.varFrames.filter((f) => f.t >= pc.deathAt - 8000 && f.t <= pc.deathAt + 2000);
      const names: Record<string, string> = {};
      for (const f of frames) for (const b of f.b) names[b[0]] = this.varNames.get(b[0]) ?? b[0];
      const clip = saveClip({ id: `${pc.deathAt.toString(36)}-${crypto.randomBytes(3).toString("hex")}`, at: pc.deathAt, cluster: config.cluster, ...pc.meta, names, skins: Object.fromEntries(this.skins), frames });
      // The player hears the id of its clip, so its own history (and the VAR button) can open it.
      if (pc.c) this.send(pc.c, { t: "varClip", id: clip.id, kind: clip.kind, bag: clip.bag, at: clip.at, hash: clip.hash });
    }
  }

  private recordVar(snap: any): void {
    // Ten pictures a second (and always the one with an elimination), the last eight seconds: small enough to store each clip.
    const hasEvents = (snap.events ?? []).length > 0;
    if ((this.varTick++ & 1) === 1 && !hasEvents) return;
    // The coins on the map too (position, size, lamports), so the replay shows the map as it was, not an empty board.
    const o: number[] = [];
    for (const q of this.match.arena.orbs) o.push(Math.round(q.x), Math.round(q.y), Math.round(q.v * 10) / 10, q.l ?? 0);
    const frame: VarFrame = { t: Date.now(), b: [], o };
    for (const p of snap.players ?? []) {
      this.varNames.set(p.w, p.n);
      frame.b.push([p.w, p.head[0], p.head[1], p.r, p.m, p.bag ?? 0, p.alive ? 1 : 0, (p.body ?? []).flat()]);
    }
    const prev = this.varFrames[this.varFrames.length - 1];
    this.varFrames.push(frame);
    // Twelve seconds kept: the eight before a death and the two after it, with some margin.
    while (this.varFrames.length && frame.t - this.varFrames[0].t > 12_000) this.varFrames.shift();
    // A clip for every elimination with money at stake (an entry or a bag) and for every cash out.
    for (const ev of snap.events ?? []) {
      if (ev.k !== "death") continue;
      const p = this.match.arena.player(ev.w);
      const before = prev?.b.find((x) => x[0] === ev.w);
      // A cash out (finished, or stopped by a rival halfway) shows what reached the wallet.
      const cashing = ev.by === "cashout" || (p?.cashedBag ?? 0) > 0;
      const bag = cashing ? (p?.cashedBag ?? before?.[5] ?? 0) : (before?.[5] ?? 0);
      const entry = p?.entry ?? 0;
      if (!(cashing || entry > 0 || bag > 0)) continue;
      // Only plays that involve a person are kept (bots against bots happen every second and nobody asks for them).
      const human = (w: string) => this.slots.some((sl) => sl.client && sl.humanW === w);
      if (!human(ev.w) && !human(ev.by)) continue;
      const slot = this.slots.find((sl) => sl.client && sl.humanW === ev.w);
      // Where it happened: the head of the body just before, so the replay can mark the spot.
      this.pendingClips.push({ deathAt: frame.t, c: slot?.client ?? null, meta: { victim: ev.w, by: ev.by, kind: cashing ? "cashout" : "eliminated", bag, entry, ...(before ? { spot: [before[1], before[2]] as [number, number] } : {}) } });
    }
    this.flushClips();
  }

  private humanDied(i: number): void {
    const c = this.slots[i].client;
    // Cash arena: who cashed out hears what it took out and its multiple of the entry.
    const p = this.player(i);
    // A cash out that moved nothing (stopped before the first lamport left) is an ordinary elimination, not a cash out.
    if (c && p && p.cashedBag !== undefined && (p.cashedBag > 0 || p.killer === "cashout")) {
      // The cash out is paid on chain from the vault to the wallet that entered; the player hears the signature.
      const bag = p.cashedBag, entry = p.entry ?? 0, to = this.slots[i].humanW;
      p.cashedBag = undefined;
      const full = p.killer === "cashout";
      void payOut(to, bag).then((sig) => { if (sig) attachPaySig(to, sig); this.send(c, { t: "cashedOut", bag, entry, full, ...(full ? {} : { by: p.killer }), ...(sig ? { sig } : {}) }); });
    }
    if (c?.live) c.live.dead = true;
    if (c) this.send(c, { t: "live", state: "dead", ...this.stats() });
    this.vacate(i);
  }

  private promote(): void {
    while (this.queue.length > 0) {
      const slot = this.freeSlot();
      if (slot < 0) return;
      const next = this.queue.shift()!;
      if (next.c.ws.readyState !== 1) continue;
      this.seat(slot, next.c, next.name, next.wallet);
    }
    for (const q of this.queue) this.status(q.c);
  }
}

void config;
