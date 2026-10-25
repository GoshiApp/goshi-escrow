// Guest rooms: free multiplayer rooms with a short shareable code, for the test site (GUEST_ROOMS=1, devnet only).
// No wallet, no chain, no money: the room plays the same minute of frenzy and the same arena as practice, and it is
// filled up with bots like a practice match is. A room lives in a lobby until the host starts it, and closes when it
// empties or when the match is over.
import crypto from "node:crypto";
import { config, log } from "./config.js";
import { Match } from "./match.js";
import type { TrapKind } from "./game/arena.js";
import { frenzyFor } from "./frenzy-for.js";
import { reservedName } from "./names.js";
import type { Client } from "./rooms.js";

export const GROOM_MAX_PLAYERS = 20;
export const GROOM_MAX_ROOMS = 20;
export const GROOM_ROSTER_SIZE = 20;
export const GROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** A lobby nobody starts is closed after this long. */
const LOBBY_TTL_MS = 15 * 60_000;

export function newGuestCode(rng: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += GROOM_CODE_ALPHABET[Math.floor(rng() * GROOM_CODE_ALPHABET.length)];
  return code;
}

interface Member {
  c: Client;
  n: string;
  w: string;
  host: boolean;
  /** Joined after the start: waits for a body (one of the bots' places) until the arena is on. */
  waiting?: boolean;
}

interface GRoom {
  code: string;
  members: Member[];
  match?: Match;
  idle: ReturnType<typeof setTimeout>;
  /** While a match runs: places people who joined with the code after the start. */
  seatTimer?: ReturnType<typeof setInterval>;
}

const cleanName = (raw: string): string => {
  let n = raw.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 14).trim();
  if (reservedName(n)) n = `Player${Math.floor(1000 + Math.random() * 9000)}`;
  return n || "You";
};

export class GuestRooms {
  private rooms = new Map<string, GRoom>();

  constructor(private send: (c: Client, msg: object) => void, private rng: () => number = Math.random) {}

  get size(): number {
    return this.rooms.size;
  }

  stop(): void {
    for (const room of [...this.rooms.values()]) this.close(room);
  }

  create(c: Client, name: string): void {
    if (c.groom) this.leave(c);
    if (this.rooms.size >= GROOM_MAX_ROOMS) return this.error(c, "busy", "Too many guest rooms are open, try again in a minute.");
    let code = newGuestCode(this.rng);
    while (this.rooms.has(code)) code = newGuestCode(this.rng);
    const w = `you_${crypto.randomBytes(6).toString("hex")}`;
    const room: GRoom = {
      code,
      members: [{ c, n: cleanName(name), w, host: true }],
      idle: setTimeout(() => this.expire(code), LOBBY_TTL_MS),
    };
    this.rooms.set(code, room);
    c.groom = { code, you: w };
    this.send(c, { t: "groom_created", ...this.lobbyView(room) });
  }

  join(c: Client, name: string, code: string): void {
    if (c.groom) this.leave(c);
    const room = this.rooms.get(code);
    if (!room) return this.error(c, "no_room", "There is no open guest room with that code.");
    if (room.members.length >= GROOM_MAX_PLAYERS) return this.error(c, "busy", "That guest room is full.");
    const w = `you_${crypto.randomBytes(6).toString("hex")}`;
    // A match already running takes the newcomer too: it gets a bot's place as soon as the arena is on.
    room.members.push({ c, n: cleanName(name), w, host: false, waiting: !!room.match });
    c.groom = { code, you: w };
    this.send(c, { t: "groom_created", ...this.lobbyView(room) });
    this.announce(room, c);
    if (room.match) this.seatLate(room);
  }

  async start(c: Client): Promise<void> {
    const room = this.roomOf(c);
    if (!room || room.match) return;
    if (!room.members.find((m) => m.c === c)?.host) return this.error(c, "not_host", "Only the host can start the match.");
    clearTimeout(room.idle);
    const id = `groom-${room.code}`;
    const roster = [
      ...room.members.map((m) => ({ w: m.w, n: m.n, role: "paid" as const, bot: false })),
      ...Array.from({ length: Math.max(0, GROOM_ROSTER_SIZE - room.members.length) }, (_, i) => ({
        w: `bot_${crypto.randomBytes(5).toString("hex")}`,
        n: `Bot ${i + 1}`,
        role: (i >= 9 ? "saboteur" : "paid") as "paid" | "saboteur",
        bot: true,
      })),
    ];
    // A guest match has no chain behind it: the seed is random and no proof is published, like practice.
    const fz = await frenzyFor(id, undefined, crypto.randomBytes(32));
    const match = new Match(
      id,
      "royale",
      roster,
      fz.seed,
      config.practiceMs,
      Date.now() + 2500,
      (snap) => this.broadcast(room, snap),
      (res) => this.onEnd(room, res),
      config.practiceShrinkStartMs,
      fz.opts,
      false,
      0,
    );
    room.match = match;
    for (const m of room.members) {
      this.send(m.c, { t: "entered", roomId: id, role: "paid", practice: true, guest: true });
      this.send(m.c, { ...match.startMsg(m.w), practice: true });
    }
    match.begin();
    room.seatTimer = setInterval(() => this.seatLate(room), 1000);
    log("groom_started", { code: room.code, players: room.members.length });
  }

  leave(c: Client): void {
    const room = this.roomOf(c);
    if (!room) return;
    const i = room.members.findIndex((m) => m.c === c);
    if (i < 0) return;
    room.members.splice(i, 1);
    c.groom = undefined;
    if (room.match) return; // the match keeps running for the others; the leaver's body stands still
    if (room.members.length === 0) return this.close(room);
    if (i === 0) room.members[0].host = true;
    this.announce(room);
  }

  /** The connection closed: whatever it held is freed. */
  drop(c: Client): void {
    this.leave(c);
  }

  /** A free trap in a guest room (a few seconds between two). */
  trap(c: Client, kind: TrapKind): ReturnType<Match["trap"]> | null {
    const room = this.roomOf(c);
    if (!room?.match || !c.groom) return null;
    return room.match.trap(c.groom.you, kind, true);
  }

  input(c: Client, dx: number, dy: number, boost: boolean): void {
    const room = this.roomOf(c);
    if (!room?.match || !c.groom) return;
    room.match.setInput(c.groom.you, dx, dy, boost);
  }

  // ------------------------------------------------------------------ internals

  private roomOf(c: Client): GRoom | undefined {
    return c.groom ? this.rooms.get(c.groom.code) : undefined;
  }

  private lobbyView(room: GRoom) {
    return { code: room.code, players: room.members.map((m) => ({ n: m.n, host: m.host })), max: GROOM_MAX_PLAYERS };
  }

  /** The lobby changed: everybody but `except` hears the new player list. */
  private announce(room: GRoom, except?: Client): void {
    const msg = { t: "groom_update", players: room.members.map((m) => ({ n: m.n, host: m.host })) };
    for (const m of room.members) if (m.c !== except) this.send(m.c, msg);
  }

  private broadcast(room: GRoom, snap: object): void {
    for (const m of room.members) this.send(m.c, snap);
  }

  private onEnd(room: GRoom, res: { ranking: unknown[] }): void {
    for (const m of room.members) {
      this.send(m.c, {
        t: "end",
        roomId: `groom-${room.code}`,
        mode: "royale",
        practice: true,
        ranking: res.ranking,
        payout: { pot: "0", rake: "0", podium: [], unclaimed: "0", jackpot: { triggered: false, amount: "0", winner: null } },
        tx: null,
        error: null,
      });
      m.c.groom = undefined;
    }
    this.close(room);
  }

  private expire(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.match) return;
    for (const m of room.members) {
      this.send(m.c, { t: "error", code: "no_room", message: "That guest room timed out." });
      m.c.groom = undefined;
    }
    this.close(room);
  }

  /** Gives the people who joined after the start a body: a bot's place (a dead one first, else the lightest bot). */
  private seatLate(room: GRoom): void {
    const match = room.match;
    if (!match || !match.inArena) return;
    for (const m of room.members) {
      if (!m.waiting) continue;
      const bots = match.arena.players.filter((p) => p.bot);
      const spot = bots.find((p) => !p.alive) ?? bots.sort((a, b) => a.m - b.m)[0];
      if (!spot) break;
      match.arena.claim(spot, m.w, m.n);
      m.waiting = false;
      this.send(m.c, { t: "entered", roomId: `groom-${room.code}`, role: "paid", practice: true, guest: true });
      this.send(m.c, { ...match.startMsg(m.w), practice: true });
    }
  }

  private close(room: GRoom): void {
    clearTimeout(room.idle);
    if (room.seatTimer) clearInterval(room.seatTimer);
    room.match?.stop();
    room.match = undefined;
    for (const m of room.members) if (m.c.groom?.code === room.code) m.c.groom = undefined;
    room.members = [];
    this.rooms.delete(room.code);
  }

  private error(c: Client, code: string, message: string): void {
    this.send(c, { t: "error", code, message });
  }
}
