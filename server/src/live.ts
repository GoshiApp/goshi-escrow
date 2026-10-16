// The live arena: one survival arena that is always running, with 20 places. Bots with fixed addresses fill every place; a person
// who enters takes the place of a bot, and when it is over (or the person leaves) the bot comes back. When all the places hold
// people the next ones wait in a queue, in order. Nothing here is simulated: the queue and the counts are the real ones.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { config, log } from "./config.js";
import { Match } from "./match.js";
import { setBotDifficulty, type Player } from "./game/arena.js";
import type { Client } from "./rooms.js";
import { FOUNDER_SKINS, OPEN_SKINS, isFounder } from "./game/skins.js";

export const LIVE_PLACES = 20;
/** The project's own wallet: only a connection that signed in with it (verified by the server) gets the eating power. */
const CEO_WALLET = "2kLcGpwnpz5eroGRW2kWqCdizmPEGDLTb5JAce9u2GJ9";
/** Viewers of the live arena: a whole server, and one address (a script cannot pull the pictures over and over). */
const MAX_SPECTATORS = 80;
const MAX_PER_ADDRESS = 2;

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

  constructor(private send: (c: Client, msg: object) => void) {
    this.slots = Array.from({ length: LIVE_PLACES }, (_, i) => {
      const w = botAddress(i);
      return { botW: w, botN: short(w), client: null, humanW: "" };
    });
    const roster = this.slots.map((s) => ({ w: s.botW, n: s.botN, role: "paid" as const, bot: true }));
    const seed = crypto.randomBytes(4).readUInt32BE(0);
    const SIX_HOURS = 6 * 3600_000;
    this.match = new Match("live-arena", "royale", roster, seed, SIX_HOURS, Date.now() + 500, (snap) => this.onSnap(snap), () => {
      // It never ends on its own; if it does, the server starts it again.
      log("live_arena_ended", {});
    }, SIX_HOURS, undefined, true, 0);
    setBotDifficulty(this.match.arena, "insane");
    this.match.begin();
    this.statusTimer = setInterval(() => this.broadcastStatus(), 4000);
    log("live_arena_started", { places: LIVE_PLACES });
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
    return { places: LIVE_PLACES, humans: this.humans(), waiting: this.queue.length, watching: this.subs.size };
  }

  // ------------------------------------------------------------------ what clients hear

  private frame = 0;
  /** What the viewers missed in the picture they skipped: the orbs eaten and dropped, to be sent with the next one. */
  private skipped: { eaten: number[]; fresh: { id: number }[] } | null = null;

  private onSnap(snap: any) {
    const text = JSON.stringify(snap);
    // Who only watches gets every other picture (10 a second, smoothed on the page); who plays gets all of them. A picture with an
    // elimination or a coin shower always goes to everybody. The orbs of a skipped picture travel with the next one, so the map of
    // a viewer never drifts from the real one.
    const half = (this.frame++ & 1) === 1 && (snap.events?.length ?? 0) === 0 && !snap.drop && !this.skipped;
    let viewerText = text;
    if (half) {
      this.skipped = { eaten: [...(snap.eatenOrbs ?? [])], fresh: [...(snap.newOrbs ?? [])] };
    } else if (this.skipped) {
      const eatenNow = new Set<number>(snap.eatenOrbs ?? []);
      const freshBefore = new Set(this.skipped.fresh.map((o) => o.id));
      viewerText = JSON.stringify({
        ...snap,
        eatenOrbs: [...this.skipped.eaten, ...(snap.eatenOrbs ?? []).filter((id: number) => !freshBefore.has(id))],
        newOrbs: [...this.skipped.fresh.filter((o) => !eatenNow.has(o.id)), ...(snap.newOrbs ?? [])],
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

  watch(c: Client): boolean {
    if (!this.subs.has(c)) {
      if (this.subs.size >= MAX_SPECTATORS) return false;
      if (c.ip && [...this.subs].filter((x) => x.ip === c.ip).length >= MAX_PER_ADDRESS) return false;
      this.subs.add(c);
    }
    c.live ??= { spectator: `spec_${crypto.randomBytes(5).toString("hex")}`, slot: null };
    this.send(c, { ...this.match.startMsg(c.live.spectator), practice: true, live: true });
    this.send(c, { t: "skins", map: Object.fromEntries(this.skins) });
    this.status(c);
    return true;
  }

  join(c: Client, name: string, wallet: string | null, skin: string | null = null): void {
    if (!this.subs.has(c) && !this.watch(c)) return;
    if (c.live!.slot !== null || this.queue.some((q) => q.c === c)) return this.status(c);
    c.live!.dead = false;
    c.live!.skin = this.allowedSkin(c, skin);
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
    if (OPEN_SKINS.includes(id)) return id;
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
    const label = name || (verified ? short(verified) : short(w.replace("you_", "")));
    s.client = c;
    s.humanW = w;
    this.match.arena.claim(p, w, label);
    const skin = c.live!.skin ?? null;
    if (skin) this.skins.set(w, skin);
    this.broadcastSkins();
    p.ceo = c.wallet === CEO_WALLET;
    p.afk = false;
    c.live!.slot = i;
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
    if (p) { p.ceo = false; p.afk = false; this.match.arena.release(p, s.botW, s.botN); }
    if (c?.live) c.live.slot = null;
    this.promote();
  }

  private humanDied(i: number): void {
    const c = this.slots[i].client;
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
