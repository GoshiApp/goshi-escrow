import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import nacl from "tweetnacl";
import type WebSocket from "ws";
import { config, log } from "./config.js";
import { holding } from "./ideas.js";
import { archiveMatch } from "./archive.js";
import { accrueRoom, setReferrer } from "./referrals.js";
import { loadSecret, markStarted } from "./secrets.js";
import { isNewVisitorToday, noteWallet } from "./visitors.js";
import { payPracticePrize } from "./practicePrize.js";
import { duelTierAllowed, limits } from "./limits.js";
import { maintenancePublic, maintenanceState, newMatchesAllowed } from "./maintenance.js";
import { settleDuel } from "./game/settlement.js";
import { FOUNDER_SKINS, SKIN_HOLD_USD, isFounder, isKnownSkin } from "./game/skins.js";
import { authMessage, makeSession, newNonce, SESSION_TTL_MS, sessionSecretFrom, verifyAuth, verifySession } from "./auth.js";
import { authority, cancelRoom, createRoom, blockhashOfSlot, fetchRoom, finalizeDuel, finalizeRoyale, buildDuelTx, finalizeVs, forgetSecret, startDuel, joinWithPass, listRooms, roomSecret, startVs, type ChainRoom } from "./chain.js";
import { Match, type FrenzyOptions, type MatchResult } from "./match.js";
import { latestSnapshot, takeSnapshot } from "./snapshot.js";
import { addMatch, addVisit, counts } from "./counters.js";
import { jackpotDraw, settleRoyale, settleVs } from "./game/settlement.js";
import { faucet, fillWithBots, isBot } from "./devbots.js";
import { feeAllowed, feeOfTier, feeOptions, refreshPrice, solPriceUsd, tierUsdOf } from "./price.js";

export interface Client {
  ws: WebSocket;
  nonce: string;
  wallet?: string;
  watching: Set<string>;
  entered?: string;
  practice?: { match: Match; you: string };
  tokens: number;
  lastRefill: number;
  /** Asked for the live numbers of the landing page. */
  watchStats?: boolean;
  visitCounted?: boolean;
  /** The random browser id (never an address): lets several tabs of one browser count as one person. */
  vid?: string;
  /** The address the connection came from (as Google's front end saw it): only used for limits, never stored. */
  ip?: string;
  /** Budget of room lookups that need a call to the node (refilled over time), so a client cannot turn messages into RPC calls. */
  lookups?: number;
}

/** A room id is a u64 written in decimal. Anything else is refused before it costs a lookup or a byte of memory. */
const ROOM_ID = /^\d{10,20}$/;
const roomIdOf = (v: unknown): string | null => ((typeof v === "string" || typeof v === "number") && ROOM_ID.test(String(v)) ? String(v) : null);
const MAX_WATCHING = 20;
const MAX_PRACTICE_PER_IP = 6;
const ROOMS_PER_IP_PER_HOUR = 20;

interface Pending {
  mode: "royale" | "vs" | "duel";
  result: MatchResult;
  payout: any;
  jackpotWinner: string | null;
  since: number;
  attempts: number;
}

interface Entry {
  chain: ChainRoom;
  watchers: Set<Client>;
  firstSeen: number;
  match?: Match;
  starting?: boolean;
  pending?: Pending;
  offer?: { expires: number; accepted: Set<string> };
  lastLobby: string;
  /** Revealed at settlement: the committed secret and the blockhash the seed used. */
  seedParts?: { secret: Buffer; blockhash: Uint8Array; slot: string };
  /** How many times the block of the activation slot could not be read yet (the match starts when it can). */
  seedTries?: number;
}

const SESSION_SECRET = sessionSecretFrom(authority.secretKey);
/** Hosts a sign-in text may name: the allowed web origins (and localhost for tests). */
const AUTH_HOSTS = config.allowedOrigins.flatMap((o) => { try { return [new URL(o).host]; } catch { return []; } });
const sha256 = (...parts: (Uint8Array | string)[]) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/**
 * Everything a room needs to be reproducible: the seed from sha256(secret, blockhash, room id), the frozen price photo and
 * the signature of that photo. The secret was committed to when the room was created and is revealed at settlement.
 */
async function frenzyFor(roomId: string, known: Buffer | undefined, blockhash: Uint8Array) {
  const secret = known ?? crypto.randomBytes(32);
  const idBytes = /^\d+$/.test(roomId) ? (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(roomId)); return b; })() : sha256(roomId).subarray(0, 8);
  const seedHash = sha256(secret, blockhash, idBytes);
  const seed = (seedHash.readUInt32LE(0) & 0x7fffffff) || 1;
  const snapshot = await takeSnapshot();
  const commit = sha256(secret).toString("hex");
  const sig = nacl.sign.detached(Buffer.from(`${snapshot.hash}|${commit}|${roomId}`), authority.secretKey);
  const opts: FrenzyOptions = { snapshot, commit, signature: Buffer.from(sig).toString("hex") };
  return { seed, secret, blockhash, opts, committed: known !== undefined };
}
const short = (w: string) => `${w.slice(0, 4)}..${w.slice(-4)}`;
const send = (c: Client, msg: object) => {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
};
const err = (c: Client, code: string, message: string) => send(c, { t: "error", code, message });

export class Hub extends EventEmitter {
  readonly clients = new Set<Client>();
  readonly rooms = new Map<string, Entry>();
  private created = new Map<string, number[]>();
  /** Rooms and duels started from one address in the last hour (a script with fresh wallets is still one address). */
  private createdByIp = new Map<string, number[]>();
  /** Room ids the node said do not exist, remembered for a few seconds so repeated asks cost nothing. */
  private missing = new Map<string, number>();
  /** Wallet -> cosmetic skin id (validated), used when a room starts. */
  private skinOf = new Map<string, string>();
  /** Private duels waiting or running: room id -> creator and size. Persisted so a restart does not forget them. */
  private duelMeta = new Map<string, { creator: string; max: number; at?: number }>();
  /** Invitations already shown to each connection, so a duel is announced once. */
  private invited = new WeakMap<Client, Set<string>>();
  private duelChecked = new Set<string>();
  /** Pass offers: wallet -> the room it may enter for free and until when. */
  private offers = new Map<string, { roomId: string; expires: number; tierUsd: number; rank: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  /** At most 5 visits a second are counted (refilled every second): a script cannot inflate the number. */
  private visitBudget = 5;
  /** The replays of the last matches, for the replay endpoint. Totals live in counters.ts (persistent). */
  private replayStore = new Map<string, Map<string, Uint8Array>>();

  private keepReplays(roomId: string, match: Match) {
    const m = new Map<string, Uint8Array>();
    for (const r of match.replayIndex()) {
      const b = match.replayOf(r.w);
      if (b) m.set(r.w, b);
    }
    this.replayStore.set(roomId, m);
    while (this.replayStore.size > 60) this.replayStore.delete(this.replayStore.keys().next().value as string);
  }

  replayOf(roomId: string, wallet: string): Uint8Array | null {
    return this.replayStore.get(roomId)?.get(wallet) ?? null;
  }

  /** What the landing page shows: people connected, people in a match, matches, volume and the prices of the gems. */
  statsMsg() {
    // People, not sockets: a browser with three tabs is one person, and the team's own browsers (no id, founder wallet) are not counted.
    const key = (c: Client): string | null => c.vid ?? (c.wallet && !isFounder(c.wallet) && !isBot(c.wallet) ? `w:${c.wallet}` : null);
    const online = new Set<string>();
    const playingSet = new Set<string>();
    for (const c of this.clients) {
      const k = key(c);
      if (!k) continue;
      online.add(k);
      if (c.entered || c.practice) playingSet.add(k);
    }
    const playing = playingSet.size;
    const snap = latestSnapshot();
    const totals = counts();
    return {
      t: "stats",
      online: online.size,
      playing,
      visits: totals.visits,
      matches: totals.matches,
      volume: totals.volume.toString(),
      prices: snap ? { source: snap.source, at: snap.at, usd: snap.usd, mass: snap.mass } : null,
      solUsd: solPriceUsd(),
      wallets: counts().wallets,
      maintenance: maintenancePublic(),
    };
  }

  /** Money matches being played right now (a deploy waits for zero). Practice matches do not count. */
  matchesRunning(): number {
    let n = 0;
    for (const e of this.rooms.values()) if (e.match && !e.match.ended) n++;
    return n;
  }

  start() {
    setInterval(() => { this.visitBudget = 5; }, 1000);
    setInterval(() => {
      const m = this.statsMsg();
      for (const c of this.clients) if (c.watchStats) send(c, m);
    }, 2000);
    void takeSnapshot();
    setInterval(() => void takeSnapshot(), 30_000);
    this.timer = setInterval(() => void this.poll(), Number(process.env.POLL_MS ?? 4000));
    void this.poll();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // ───────────── connections ─────────────

  connect(ws: WebSocket, ip?: string): Client {
    void refreshPrice();
    const c: Client = { ws, nonce: newNonce(), watching: new Set(), tokens: 60, lastRefill: Date.now(), ip, lookups: 10 };
    this.clients.add(c);
    send(c, {
      t: "hello",
      nonce: c.nonce,
      authMessage: authMessage(c.nonce),
      siws: true,
      cluster: config.cluster,
      programId: config.programId,
      mint: config.mint,
      sessionTtlMs: SESSION_TTL_MS,
      devBots: config.devBots,
      feePresets: feeOptions().map((o) => o.lamports.toString()),
      feeOptions: feeOptions().map((o) => ({ lamports: o.lamports.toString(), usd: o.usd })),
      solUsd: solPriceUsd(),
      maintenance: maintenancePublic(),
      limits: {
        stage: limits.stage,
        maxEntryUsd: limits.sol.maxEntryUsd,
        goshi: { enabled: limits.goshi.enabled },
        duel: {
          tiers: feeOptions().filter((o) => duelTierAllowed(o.usd)).map((o) => ({ lamports: o.lamports.toString(), usd: o.usd })),
          players: limits.sol.duelPlayers,
          rakePct: limits.duel.rakePct,
          maxMinutes: limits.duel.maxMinutes,
          joinWindowMinutes: limits.duel.joinWindowMinutes,
        },
      },
      minHolder: config.minHolder.toString(),
      rules: {
        matchMs: config.matchMs,
        shrinkStartMs: config.shrinkStartMs,
        tickRate: config.tickRate,
        paidSlots: config.paidSlots,
        freeSlots: config.freeSlots,
      },
    });
    return c;
  }

  disconnect(c: Client) {
    this.clients.delete(c);
    c.practice?.match.stop();
    c.practice = undefined;
    for (const e of this.rooms.values()) e.watchers.delete(c);
  }

  async handle(c: Client, raw: string) {
    const now = Date.now();
    c.lookups = Math.min(10, (c.lookups ?? 10) + (now - c.lastRefill) / 1000);
    c.tokens = Math.min(60, c.tokens + ((now - c.lastRefill) / 1000) * 60);
    c.lastRefill = now;
    if (c.tokens < 1) return;
    c.tokens -= 1;

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return err(c, "bad_json", "Messages must be JSON.");
    }
    if (!msg || typeof msg.t !== "string") return err(c, "bad_message", "Missing message type.");

    if (msg.t === "ping") return send(c, { t: "pong" });
    // Free practice needs no wallet and moves no money.
    if (msg.t === "stats") {
      // A visit is one load of a page by one browser tab session (the page sends `visit` once). Only a number is kept.
      if (msg.visit === true && !c.visitCounted && this.visitBudget > 0) {
        c.visitCounted = true;
        this.visitBudget--;
        // One visitor per day: a random browser id, kept only as a salted hash for the day. The team's own browsers send no id.
        if (isNewVisitorToday(msg.vid)) addVisit();
      }
      if (typeof msg.vid === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(msg.vid)) c.vid = msg.vid;
      c.watchStats = msg.on !== false;
      if (c.watchStats) send(c, { ...this.statsMsg(), counted: c.visitCounted === true });
      return;
    }
    if (msg.t === "practice") return this.onPractice(c, msg);
    if (msg.t === "input" && c.practice) {
      c.practice.match.setInput(c.practice.you, Number(msg.dx), Number(msg.dy), !!msg.boost);
      return;
    }
    if (msg.t === "leave" && c.practice) {
      c.practice.match.stop();
      c.practice = undefined;
      return;
    }
    if (!c.wallet) {
      if (msg.t !== "auth") return err(c, "auth_required", "Authenticate first.");
      // A token from an earlier sign in: no wallet popup.
      const known = verifySession(msg.token, SESSION_SECRET);
      if (known && (msg.wallet === undefined || msg.wallet === known)) {
        c.wallet = known;
        if (typeof msg.vid === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(msg.vid)) c.vid = msg.vid;
        void noteWallet(known, isBot(known));
        const s = makeSession(known, SESSION_SECRET);
        return send(c, { t: "authed", wallet: known, session: s.token, expiresAt: s.expiresAt, viaToken: true });
      }
      if (typeof msg.wallet === "string" && typeof msg.signature === "string" && verifyAuth(msg.wallet, c.nonce, msg.signature, typeof msg.message === "string" ? msg.message : undefined, AUTH_HOSTS)) {
        const w: string = msg.wallet;
        c.wallet = w;
        if (typeof msg.vid === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(msg.vid)) c.vid = msg.vid;
        void noteWallet(w, isBot(w));
        const s = makeSession(w, SESSION_SECRET);
        return send(c, { t: "authed", wallet: w, session: s.token, expiresAt: s.expiresAt });
      }
      err(c, "auth_failed", "The wallet signature did not match.");
      return c.ws.close();
    }

    try {
      switch (msg.t) {
        case "createRoom":
          return await this.onCreateRoom(c, msg);
        case "quick":
          return await this.onQuick(c, msg);
        case "acceptPass": {
          const id = roomIdOf(msg.roomId);
          return id ? await this.onAcceptPass(c, id) : err(c, "bad_room", "That room id is not valid.");
        }
        case "fillWithBots":
          return roomIdOf(msg.roomId) ? await this.onFill(c, msg) : err(c, "bad_room", "That room id is not valid.");
        case "faucet":
          return await this.onFaucet(c);
        case "watch": {
          const id = roomIdOf(msg.roomId);
          return id ? await this.onWatch(c, id) : err(c, "bad_room", "That room id is not valid.");
        }
        case "enter": {
          const id = roomIdOf(msg.roomId);
          return id ? await this.onEnter(c, id) : err(c, "bad_room", "That room id is not valid.");
        }
        case "vs": {
          const id = roomIdOf(msg.roomId);
          return id ? this.onVs(c, id, !!msg.accept) : err(c, "bad_room", "That room id is not valid.");
        }
        case "ref": {
          const r = String(msg.ref ?? "");
          if (c.wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r)) void setReferrer(c.wallet, r);
          return;
        }
        case "createDuel":
          return void (await this.onCreateDuel(c, msg));
        case "startDuel": {
          const id = roomIdOf(msg.roomId);
          return void (id ? await this.onStartDuel(c, id) : err(c, "bad_room", "That room id is not valid."));
        }
        case "skin":
          return void (await this.onSkin(c, msg));
        case "input":
          return this.onInput(c, msg);
        case "leave": {
          const id = roomIdOf(msg.roomId);
          return id ? this.onLeave(c, id) : undefined;
        }
        default:
          return err(c, "unknown_message", "Unknown message type.");
      }
    } catch (e: any) {
      log("handler_error", { t: msg.t, error: String(e?.message ?? e) });
      err(c, "server_error", "Something went wrong on the server.");
    }
  }

  // ───────────── client messages ─────────────

  /** A free match against bots, started on demand. No chain, no money, no wallet. */
  private async onPractice(c: Client, msg: any) {
    if (c.practice) {
      c.practice.match.stop();
      c.practice = undefined;
    }
    if (maintenanceState() === "down") return err(c, "maintenance", "Scheduled maintenance: practice is closed until it ends.");
    const live = [...this.clients].filter((x) => x.practice);
    if (live.length >= config.maxPractice) return err(c, "busy", "Practice is full right now, try again in a minute.");
    // One address cannot fill every practice slot and shut everybody else out.
    if (c.ip && live.filter((x) => x.ip === c.ip).length >= MAX_PRACTICE_PER_IP) return err(c, "busy", "Too many practice matches from your connection, finish one first.");
    const you = `you_${crypto.randomBytes(6).toString("hex")}`;
    const prizeWallet = typeof msg.wallet === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(msg.wallet) ? msg.wallet : null;
    const raw = typeof msg.name === "string" ? msg.name.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 14).trim() : "";
    const roster = [
      { w: you, n: raw || "You", role: "paid" as const, bot: false },
      ...Array.from({ length: 12 }, (_, i) => ({
        w: `bot_${crypto.randomBytes(5).toString("hex")}`,
        n: `Bot ${i + 1}`,
        role: (i >= 9 ? "saboteur" : "paid") as "paid" | "saboteur",
        bot: true,
      })),
    ];
    const id = `practice-${crypto.randomBytes(4).toString("hex")}`;
    // A practice match has no chain: its seed is random, and it says so (no proof is published for it).
    const fz = await frenzyFor(id, undefined, crypto.randomBytes(32));
    const match = new Match(
      id,
      "royale",
      roster,
      fz.seed,
      config.practiceMs,
      Date.now() + 2500,
      (snap) => send(c, snap),
      async (res) => {
        // A connected wallet that finishes in the top three of a practice match is paid test SOL (devnet only).
        const place = res.ranking.find((r) => r.w === you)?.rank ?? 0;
        const prize = prizeWallet && place > 0 ? await payPracticePrize(prizeWallet, place) : null;
        send(c, {
          t: "end",
          roomId: id,
          mode: "royale",
          practice: true,
          ...(prize ? { prize } : {}),
          ranking: res.ranking,
          payout: { pot: "0", rake: "0", podium: [], unclaimed: "0", jackpot: { triggered: false, amount: "0", winner: null } },
          tx: null,
          error: null,
          record: match.arenaRecordInfo() ?? undefined,
        });
        this.keepReplays(id, match);
        c.practice = undefined;
      },
      config.practiceShrinkStartMs,
      fz.opts,
    );
    c.practice = { match, you };
    send(c, { t: "entered", roomId: id, role: "paid", practice: true });
    send(c, { ...match.startMsg(you), practice: true });
    match.begin();
    log("practice_started", { id });
  }

  /** The cosmetic skin a signed in wallet wears in paid rooms. A holder skin needs the balance on chain. */
  private async onSkin(c: Client, msg: any) {
    if (!c.wallet) return;
    const id = msg.id;
    if (!isKnownSkin(id)) return void this.skinOf.delete(c.wallet);
    if (FOUNDER_SKINS.includes(id) && !isFounder(c.wallet)) return void this.skinOf.delete(c.wallet);
    const need = SKIN_HOLD_USD[id];
    if (need !== undefined) {
      try {
        const h = await holding(c.wallet);
        if (!h.price || h.usd < need) return void this.skinOf.delete(c.wallet);
      } catch {
        return;
      }
    }
    this.skinOf.set(c.wallet, id);
  }

  private async onCreateRoom(c: Client, msg: any) {
    if (config.paused) return err(c, "paused", "New rooms are paused for now.");
    if (!newMatchesAllowed()) return err(c, "maintenance", "Scheduled maintenance: new rooms are closed until it ends.");
    let fee: bigint;
    try {
      fee = BigInt(msg.entryFee);
    } catch {
      return err(c, "bad_fee", "The entry fee is not valid.");
    }
    if (!feeAllowed(fee)) return err(c, "bad_fee", "That entry fee is not offered.");

    const hourAgo = Date.now() - 3600_000;
    const mine = (this.created.get(c.wallet!) ?? []).filter((t) => t > hourAgo);
    if (mine.length >= config.roomsPerWalletPerHour) return err(c, "rate_limited", "Too many rooms created, try again later.");
    if (this.ipLimited(c)) return err(c, "rate_limited", "Too many rooms created from your connection, try again later.");
    const open = [...this.rooms.values()].filter((e) => e.chain.state === "waiting").length;
    if (open >= config.maxOpenRooms) return err(c, "too_many_rooms", "Too many open rooms right now.");

    mine.push(Date.now());
    this.created.set(c.wallet!, mine);
    const { roomId, tx } = await createRoom(fee);
    send(c, { t: "roomCreated", roomId, tx });
    void this.poll();
  }

  /**
   * A private duel by contract: the host names 1 to 4 wallets, the server builds a transaction that the host's wallet signs, and
   * the program only lets those wallets take a seat. The winner takes the pot minus a small fee.
   */
  private async onCreateDuel(c: Client, msg: any) {
    if (config.paused) return err(c, "paused", "New rooms are paused for now.");
    if (!newMatchesAllowed()) return err(c, "maintenance", "Scheduled maintenance: new duels are closed until it ends.");
    let fee: bigint;
    try {
      fee = BigInt(msg.entryFee);
    } catch {
      return err(c, "bad_fee", "The entry fee is not valid.");
    }
    if (!duelTierAllowed(tierUsdOf(fee)) || !feeAllowed(fee)) return err(c, "bad_fee", "That entry fee is not offered for duels.");
    const me = c.wallet!;
    const raw: unknown[] = Array.isArray(msg.guests) ? msg.guests : [];
    const guests: string[] = [];
    for (const g of raw) {
      const w = String(g).trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return err(c, "bad_guest", "One of the addresses is not a valid wallet.");
      if (w === me || guests.includes(w)) return err(c, "bad_guest", "Invite each wallet once, and not yourself.");
      guests.push(w);
    }
    const [minP, maxP] = limits.sol.duelPlayers;
    if (guests.length < minP - 1 || guests.length > maxP - 1) return err(c, "bad_players", `Invite from ${minP - 1} to ${maxP - 1} wallets.`);
    const open = [...this.duelMeta].filter(([id, m]) => m.creator === me && this.rooms.get(id)?.chain.state === "waiting").length;
    if (open >= limits.sol.maxOpenDuelsPerWallet) return err(c, "too_many_duels", "You have too many open duels.");
    const hourAgo = Date.now() - 3600_000;
    const mine = (this.created.get(me) ?? []).filter((t) => t > hourAgo);
    if (mine.length >= limits.sol.maxDuelsPerWalletPerHour) return err(c, "rate_limited", "Too many duels created, try again later.");
    if (this.ipLimited(c)) return err(c, "rate_limited", "Too many duels created from your connection, try again later.");
    const openAll = [...this.rooms.values()].filter((e) => e.chain.state === "waiting").length;
    if (openAll >= config.maxOpenRooms) return err(c, "too_many_rooms", "Too many open rooms right now.");
    mine.push(Date.now());
    this.created.set(me, mine);
    const { roomId, tx } = await buildDuelTx(me, fee, guests);
    this.duelMeta.set(roomId, { creator: me, max: guests.length + 1, at: Date.now() });
    void persistDuel(roomId, me, guests.length + 1);
    send(c, { t: "duelTx", roomId, tx, players: guests.length + 1, guests });
  }

  private async onStartDuel(c: Client, roomId: string) {
    const e = await this.entryFor(roomId, c);
    if (!e || !this.duelMeta.has(roomId)) return err(c, "no_room", "That duel does not exist.");
    if (this.duelMeta.get(roomId)!.creator !== c.wallet) return err(c, "not_creator", "Only who made the duel can start it early.");
    if (e.chain.state !== "waiting" || e.chain.paid.length < limits.sol.duelPlayers[0]) return err(c, "not_ready", "The duel needs at least two players.");
    try {
      await startDuel(roomId);
    } catch (ex: any) {
      log("duel_start_failed", { roomId, error: String(ex?.message ?? ex).slice(0, 160) });
      return err(c, "start_failed", "The duel could not start, try again.");
    }
    void this.poll();
  }

  /** Quick match: the fullest waiting room with this fee and a free paid seat, or a new one. The web then takes the seat. */
  private async onQuick(c: Client, msg: any) {
    if (config.paused) return err(c, "paused", "New rooms are paused for now.");
    if (!newMatchesAllowed()) return err(c, "maintenance", "Scheduled maintenance: new rooms are closed until it ends.");
    let fee: bigint;
    try {
      fee = BigInt(msg.entryFee);
    } catch {
      return err(c, "bad_fee", "The entry fee is not valid.");
    }
    if (!feeAllowed(fee)) return err(c, "bad_fee", "That entry fee is not offered.");
    const me = c.wallet!;
    const candidates = [...this.rooms.values()]
      .map((e) => e.chain)
      .filter((r) => r.state === "waiting" && r.mode === "royale" && !this.duelMeta.has(r.id) && r.entryFee === fee && r.paid.length < config.paidSlots && !r.paid.includes(me) && !r.free.includes(me))
      .sort((a, b) => b.paid.length - a.paid.length);
    if (candidates.length > 0) {
      return send(c, { t: "quickRoom", roomId: candidates[0].id, created: false, paid: candidates[0].paid.length });
    }
    const hourAgo = Date.now() - 3600_000;
    const mine = (this.created.get(me) ?? []).filter((t) => t > hourAgo);
    if (mine.length >= config.roomsPerWalletPerHour) return err(c, "rate_limited", "Too many rooms created, try again later.");
    if (this.ipLimited(c)) return err(c, "rate_limited", "Too many rooms created from your connection, try again later.");
    const open = [...this.rooms.values()].filter((e) => e.chain.state === "waiting").length;
    if (open >= config.maxOpenRooms) return err(c, "too_many_rooms", "Too many open rooms right now.");
    mine.push(Date.now());
    this.created.set(me, mine);
    const { roomId, tx } = await createRoom(fee);
    void this.poll();
    send(c, { t: "quickRoom", roomId, created: true, paid: 0, tx });
  }

  private async onFill(c: Client, msg: any) {
    if (!config.devBots) return err(c, "dev_bots_off", "Test bots are not enabled on this server.");
    const roomId = String(msg.roomId);
    const room = await fetchRoom(roomId);
    if (!room) return err(c, "no_room", "That room does not exist.");
    if (room.state !== "waiting") return err(c, "not_waiting", "That room is not waiting for players.");
    const paid = Math.max(0, Math.min(Number(msg.paid ?? 0), config.paidSlots - room.paid.length));
    const free = Math.max(0, Math.min(Number(msg.free ?? 0), config.freeSlots - room.free.length));
    send(c, { t: "botsJoining", roomId, paid, free });
    void fillWithBots(roomId, paid, free)
      .then(() => this.poll())
      .catch((e) => {
        log("fill_failed", { roomId, error: String(e?.message ?? e) });
        err(c, "fill_failed", "The test bots could not join the room.");
      });
  }

  private async onFaucet(c: Client) {
    if (!config.devBots) return err(c, "faucet_off", "The test faucet is not enabled on this server.");
    try {
      const r = await faucet(c.wallet!);
      send(c, { t: "faucet", sol: r.sol, goshi: r.goshi, tx: r.tx });
    } catch (e: any) {
      const code = String(e?.message ?? "");
      if (code === "faucet_rate_limited") return err(c, code, "The faucet can be used once every 10 minutes.");
      if (code === "faucet_enough_tokens") return err(c, code, "You already hold enough test funds.");
      if (code === "faucet_empty") return err(c, code, "The test faucet is empty right now. Get devnet SOL at faucet.solana.com and try again.");
      throw e;
    }
  }

  /** True when this address already started its share of rooms this hour; records the attempt otherwise. */
  private ipLimited(c: Client): boolean {
    if (!c.ip) return false;
    const hourAgo = Date.now() - 3600_000;
    const mine = (this.createdByIp.get(c.ip) ?? []).filter((t) => t > hourAgo);
    if (mine.length >= ROOMS_PER_IP_PER_HOUR) { this.createdByIp.set(c.ip, mine); return true; }
    mine.push(Date.now());
    this.createdByIp.set(c.ip, mine);
    if (this.createdByIp.size > 5000) for (const [k, v] of this.createdByIp) if (v.every((t) => t <= hourAgo)) this.createdByIp.delete(k);
    return false;
  }

  /** The registry entry of a room, created from the chain if the poll has not seen the room yet. */
  private async entryFor(roomId: string, c?: Client): Promise<Entry | undefined> {
    const known = this.rooms.get(roomId);
    if (known) return known;
    const now = Date.now();
    const gone = this.missing.get(roomId);
    if (gone !== undefined && now - gone < 15_000) return undefined;
    // Looking a room up costs a call to the node: a client gets a small budget that refills slowly.
    if (c) {
      if ((c.lookups ?? 10) < 1) return undefined;
      c.lookups = (c.lookups ?? 10) - 1;
    }
    const chain = await fetchRoom(roomId);
    if (!chain) {
      this.missing.set(roomId, now);
      if (this.missing.size > 500) for (const [k, t] of this.missing) if (now - t > 15_000) this.missing.delete(k);
      return undefined;
    }
    const e: Entry = this.rooms.get(roomId) ?? { chain, watchers: new Set(), firstSeen: Date.now(), lastLobby: "" };
    this.rooms.set(roomId, e);
    return e;
  }

  private async onWatch(c: Client, roomId: string) {
    const e = await this.entryFor(roomId, c);
    if (!e) return err(c, "no_room", "That room does not exist.");
    // Only rooms that exist are remembered, and only a few: a connection cannot grow its own state without limit.
    if (c.watching.size >= MAX_WATCHING && !c.watching.has(roomId)) return err(c, "too_many_rooms", "You are watching too many rooms.");
    c.watching.add(roomId);
    e.watchers.add(c);
    send(c, this.lobbyMsg(e));
    if (e.match && !e.match.ended) send(c, e.match.startMsg(c.wallet!));
  }

  private async onEnter(c: Client, roomId: string) {
    const e = await this.entryFor(roomId, c);
    const chain = e?.chain;
    const w = c.wallet!;
    const role = chain?.paid.includes(w) ? "paid" : chain?.free.includes(w) ? "saboteur" : null;
    // Anyone can watch a duel that is being played (it is a public match); only the seated can steer.
    if (chain && !role && chain.mode === "duel" && chain.state === "active") {
      c.watching.add(roomId);
      e?.watchers.add(c);
      send(c, { t: "entered", roomId, role: "paid", spectator: true });
      if (e) {
        send(c, this.lobbyMsg(e));
        if (e.match && !e.match.ended) send(c, e.match.startMsg(w));
      }
      return;
    }
    if (!chain || !role) return err(c, "not_in_room", "Join the room on-chain first.");
    c.entered = roomId;
    c.watching.add(roomId);
    e?.watchers.add(c);
    send(c, { t: "entered", roomId, role });
    if (e) {
      send(c, this.lobbyMsg(e));
      if (e.offer) send(c, { t: "vsOffer", roomId, paid: e.chain.paid.length, expiresInMs: Math.max(0, e.offer.expires - Date.now()) });
      if (e.match && !e.match.ended) send(c, e.match.startMsg(w));
    }
  }

  private onVs(c: Client, roomId: string, accept: boolean) {
    const e = this.rooms.get(roomId);
    if (!e?.offer || !e.chain.paid.includes(c.wallet!)) return err(c, "no_offer", "There is no VS offer for you in that room.");
    if (accept) e.offer.accepted.add(c.wallet!);
    else {
      this.broadcast(e, { t: "vsDeclined", roomId });
      e.offer = undefined;
      e.firstSeen = Date.now();
    }
    void this.poll();
  }

  private onInput(c: Client, msg: any) {
    const id = c.entered;
    if (!id) return;
    this.rooms.get(id)?.match?.setInput(c.wallet!, Number(msg.dx), Number(msg.dy), !!msg.boost);
  }

  private onLeave(c: Client, roomId: string) {
    c.watching.delete(roomId);
    this.rooms.get(roomId)?.watchers.delete(c);
    if (c.entered === roomId) c.entered = undefined;
  }

  // ───────────── chain polling, VS fallback and matches ─────────────

  private lobbyMsg(e: Entry) {
    return {
      t: "lobby",
      roomId: e.chain.id,
      state: e.chain.state,
      mode: e.chain.mode,
      entryFee: e.chain.entryFee.toString(),
      paid: e.chain.paid,
      free: e.chain.free,
      waitedMs: Date.now() - e.firstSeen,
      ...(this.duelMeta.has(e.chain.id) ? { duel: this.duelMeta.get(e.chain.id) } : {}),
    };
  }

  private broadcast(e: Entry, msg: object) {
    const to = (msg as { to?: string }).to;
    for (const c of e.watchers) if (to === undefined || c.wallet === to) send(c, msg);
  }

  /** Duels that are being played now: anybody may watch them. */
  liveDuels(): { roomId: string; entryFee: string; players: string[] }[] {
    const out: { roomId: string; entryFee: string; players: string[] }[] = [];
    for (const e of this.rooms.values()) {
      if (e.chain.mode === "duel" && e.chain.state === "active" && e.match && !e.match.ended) {
        out.push({ roomId: e.chain.id, entryFee: e.chain.entryFee.toString(), players: e.chain.paid });
      }
    }
    return out;
  }

  /** Ids of the private duels that are waiting for players (kept out of the public room list). */
  duelIds(): string[] {
    return [...this.duelMeta.keys()].filter((id) => this.rooms.get(id)?.chain.state !== "active");
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const chain = await listRooms();
      const seen = new Set<string>();
      for (const r of chain) {
        seen.add(r.id);
        let e = this.rooms.get(r.id);
        if (!e) {
          e = { chain: r, watchers: new Set(), firstSeen: Date.now(), lastLobby: "" };
          this.rooms.set(r.id, e);
        }
        e.chain = r;
        if (!this.duelMeta.has(r.id) && !this.duelChecked.has(r.id) && r.state === "waiting") {
          this.duelChecked.add(r.id);
          const m = await loadDuel(r.id);
          if (m) this.duelMeta.set(r.id, m);
        }
        const key = `${r.state}:${r.mode}:${r.paid.length}:${r.free.length}`;
        if (key !== e.lastLobby) {
          e.lastLobby = key;
          this.broadcast(e, this.lobbyMsg(e));
        }
        if (r.state === "waiting" && !newMatchesAllowed() && (await this.drain(e))) continue;
        if (r.state === "waiting" && (await this.expire(e))) continue;
        // The contract is the source of truth for a duel: who hosts it and how many are invited.
        if (r.guests.length > 0 && !this.duelMeta.has(r.id) && r.paid.length > 0) this.duelMeta.set(r.id, { creator: r.paid[0], max: r.guests.length + 1 });
        const dm = this.duelMeta.get(r.id);
        if (r.mode === "duel" && r.state === "waiting" && r.guests.length > 0) {
          for (const c of this.clients) {
            if (!c.wallet || !r.guests.includes(c.wallet) || r.paid.includes(c.wallet)) continue;
            const shown = this.invited.get(c) ?? new Set<string>();
            if (shown.has(r.id)) continue;
            shown.add(r.id);
            this.invited.set(c, shown);
            send(c, { t: "invite", roomId: r.id, entryFee: r.entryFee.toString(), host: r.paid[0] ?? "", players: r.guests.length + 1 });
          }
        }
        if (r.state === "waiting" && dm) {
          if (r.paid.length >= dm.max && !e.starting) {
            try { await startDuel(r.id); } catch (ex: any) { log("duel_start_failed", { roomId: r.id, error: String(ex?.message ?? ex).slice(0, 160) }); }
          }
        } else if (r.state === "waiting") await this.vsFallback(e);
        if (r.state === "active" && !e.match && !e.starting && !e.pending) await this.startMatch(e);
        await this.recover(e);
      }
      // A duel whose transaction was never signed (the host closed the page) leaves no room: forget it after ten minutes.
      for (const [id, m] of [...this.duelMeta]) if (!seen.has(id) && m.at && Date.now() - m.at > 600_000) this.duelMeta.delete(id);
      for (const id of [...this.rooms.keys()]) {
        const e = this.rooms.get(id)!;
        if (!seen.has(id) && !(e.match && !e.match.ended)) this.rooms.delete(id);
      }
    } catch (e: any) {
      log("poll_failed", { error: String(e?.message ?? e) });
    } finally {
      this.polling = false;
    }
  }

  /** After 5 minutes of waiting with 2 to 9 paid players the server offers VS mode to the paid players. */
  private async vsFallback(e: Entry) {
    const paid = e.chain.paid;
    if (paid.length < 2 || paid.length > 9) return;
    const now = Date.now();
    if (!e.offer) {
      if (now - e.firstSeen < config.vsWaitMs) return;
      e.offer = { expires: now + config.vsOfferMs, accepted: new Set(paid.filter(isBot)) };
      for (const c of e.watchers) if (c.wallet && paid.includes(c.wallet)) send(c, { t: "vsOffer", roomId: e.chain.id, paid: paid.length, expiresInMs: config.vsOfferMs });
      log("vs_offered", { roomId: e.chain.id, paid: paid.length });
      return;
    }
    if (paid.every((w) => e.offer!.accepted.has(w))) {
      e.offer = undefined;
      try {
        await startVs(e.chain.id);
        this.broadcast(e, { t: "vsStarted", roomId: e.chain.id });
      } catch (ex: any) {
        log("vs_start_failed", { roomId: e.chain.id, error: String(ex?.message ?? ex) });
      }
    } else if (now > e.offer.expires) {
      this.broadcast(e, { t: "vsDeclined", roomId: e.chain.id });
      e.offer = undefined;
      e.firstSeen = now;
    }
  }

  private async startMatch(e: Entry) {
    e.starting = true;
    const players = [
      ...e.chain.paid.map((w) => ({ w, n: short(w), role: "paid" as const, bot: isBot(w), skin: this.skinOf.get(w) })),
      ...e.chain.free.map((w) => ({ w, n: short(w), role: "saboteur" as const, bot: isBot(w), skin: this.skinOf.get(w) })),
    ];
    const roomId = e.chain.id;
    // The match must use the secret that was committed on chain. After a restart it comes back from storage; a match that was
    // already running when the server stopped, or a room whose secret is gone, is refunded instead of being replayed.
    let known = roomSecret(roomId);
    const stored = await loadSecret(roomId);
    if (!known && stored.secret) known = stored.secret;
    if (stored.started || !known) {
      log("room_refunded_lost_match", { roomId, started: stored.started, hadSecret: !!known });
      try {
        await cancelRoom(roomId, e.chain.paid, e.chain.passPlayer);
        this.broadcast(e, { t: "error", code: "match_lost", message: "The server restarted during this match, so it was cancelled and every entry refunded." });
        this.rooms.delete(roomId);
        forgetSecret(roomId);
      } catch (ex: any) {
        e.starting = false;
        log("room_refund_failed", { roomId, error: String(ex?.message ?? ex).slice(0, 160) });
      }
      return;
    }
    // The seed uses the blockhash of the block in which the room filled: unknown to everybody (the server included) before the
    // transaction that fills it is sent, and readable by anybody afterwards. If that block cannot be read yet, wait; if it never
    // can, refund. There is no fallback to a blockhash the server could choose.
    const slot = BigInt(e.chain.activeSlot || "0");
    let blockhash: Uint8Array | null = null;
    if (slot > 0n) {
      try {
        blockhash = await blockhashOfSlot(slot);
      } catch (ex: any) {
        e.seedTries = (e.seedTries ?? 0) + 1;
        log("seed_block_unavailable", { roomId, slot: slot.toString(), tries: e.seedTries, error: String(ex?.message ?? ex).slice(0, 120) });
      }
    }
    if (!blockhash) {
      if (slot === 0n || (e.seedTries ?? 0) >= 12) {
        try {
          await cancelRoom(roomId, e.chain.paid, e.chain.passPlayer);
          this.broadcast(e, { t: "error", code: "seed_unavailable", message: "The match could not be seeded fairly, so it was cancelled and every entry refunded." });
          this.rooms.delete(roomId);
          forgetSecret(roomId);
        } catch (ex: any) {
          log("room_refund_failed", { roomId, error: String(ex?.message ?? ex).slice(0, 160) });
        }
      }
      e.starting = false;
      return;
    }
    void markStarted(roomId);
    const fz = await frenzyFor(roomId, known, blockhash);
    e.seedParts = { secret: fz.secret, blockhash: fz.blockhash, slot: slot.toString() };
    const startsAt = Date.now() + config.countdownMs;
    const isDuel = e.chain.mode === "duel";
    const match = new Match(
      roomId,
      e.chain.mode,
      players,
      fz.seed,
      isDuel ? limits.duel.maxMinutes * 60_000 : config.matchMs,
      startsAt,
      (snap) => this.broadcast(e, snap),
      (res) => void this.settle(e, res),
      isDuel ? 30_000 : undefined,
      fz.opts,
    );
    e.match = match;
    e.starting = false;
    for (const c of e.watchers) send(c, match.startMsg(c.wallet!));
    match.begin();
    log("match_started", { roomId, mode: e.chain.mode, players: players.length, startsAt });
  }

  private async settle(e: Entry, res: MatchResult) {
    const chain = e.chain;
    const entry = chain.entryFee;
    let payout: any;
    let jackpotWinner: string | null = null;
    if (res.mode === "royale") {
      // Saboteurs do not compete: the podium is the best three PAID players.
      const top = res.ranking.filter((r) => r.role === "paid").slice(0, 3);
      const nominal = entry * BigInt(chain.paid.length);
      const cash = entry * BigInt(chain.paid.length - chain.passes);
      const s = settleRoyale(nominal, cash, chain.free.length);
      if (!s) throw new Error("royale settlement does not add up");
      payout = {
        pot: nominal.toString(),
        cash: cash.toString(),
        rake: s.rake.toString(),
        podium: top.map((r, i) => ({ w: r.w, rank: i + 1, kind: "sol", lamports: s.prizes[i].toString() })),
        saboteurs: chain.free.map((w) => ({ w, lamports: s.saboteurEach.toString() })),
        unclaimed: "0",
        jackpot: { triggered: false, amount: "0", winner: null as string | null },
      };
      // Jackpot event: 1 in `jackpotOneIn` after a full royale of 10 paid players, drawn from the committed secret and the
      // blockhash of the block where the room filled, so it can be recomputed from the proof (see jackpotDraw).
      if (chain.paid.length === config.paidSlots && e.seedParts && jackpotDraw(e.seedParts.secret, e.seedParts.blockhash, chain.id, config.jackpotOneIn)) {
        jackpotWinner = top[0]?.w ?? null;
        log("jackpot_event", { roomId: chain.id, winner: jackpotWinner });
      }
    } else if (res.mode === "duel") {
      const ranking = res.ranking.map((r) => r.w);
      const s = settleDuel(entry, ranking);
      payout = {
        pot: s.pot.toString(),
        rake: s.rake.toString(),
        podium: s.payouts.map((p) => ({ w: p.wallet, rank: p.rank, kind: p.kind, lamports: p.lamports.toString() })),
        unclaimed: "0",
        jackpot: { triggered: false, amount: "0", winner: null },
      };
    } else {
      const ranking = res.ranking.map((r) => r.w);
      const s = settleVs(entry, ranking);
      payout = {
        pot: s.pot.toString(),
        rake: s.rake.toString(),
        podium: s.payouts.map((p) => ({ w: p.wallet, rank: p.rank, kind: p.kind, lamports: p.lamports.toString() })),
        unclaimed: "0",
        jackpot: { triggered: false, amount: "0", winner: null },
      };
    }
    e.pending = { mode: res.mode, result: res, payout, jackpotWinner, since: Date.now(), attempts: 0 };
    await this.trySettle(e);
  }

  /** The proof that goes into the log of the closing transaction; absent when the match had no minute of frenzy. */
  private proofOf(e: Entry) {
    if (!e.match?.frenzyOpts || !e.seedParts) return undefined;
    return e.match.proof(e.seedParts.secret, e.seedParts.blockhash);
  }

  private async trySettle(e: Entry) {
    const p = e.pending;
    if (!p) return;
    const roomId = e.chain.id;
    let tx: string | null = null;
    let error: string | null = null;
    for (let i = 0; i < 3 && !tx; i++) {
      p.attempts++;
      try {
        if (p.mode === "royale") {
          tx = await finalizeRoyale(
            roomId,
            p.result.ranking.filter((r) => r.role === "paid").slice(0, 3).map((r) => r.w),
            e.chain.free,
            this.proofOf(e),
          );
        } else if (p.mode === "duel") {
          tx = await finalizeDuel(roomId, p.result.ranking[0].w, this.proofOf(e));
        } else {
          tx = await finalizeVs(roomId, p.result.ranking.map((r) => r.w), this.proofOf(e));
        }
      } catch (ex: any) {
        error = String(ex?.message ?? ex).slice(0, 200);
        log("finalize_failed", { roomId, attempt: p.attempts, error });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (tx && p.jackpotWinner) {
      // Manual mode: the super pot is paid by hand from the vault (withdraw_vault), so the event is only recorded here.
      log("jackpot_event_manual", { roomId, winner: p.jackpotWinner });
      p.payout.jackpot = { triggered: true, amount: "0", winner: p.jackpotWinner, manual: true };
      p.jackpotWinner = null;
    }
    const msg = {
      t: "end",
      roomId,
      mode: p.mode,
      ranking: p.result.ranking,
      payout: p.payout,
      tx,
      error: tx ? null : "The prizes could not be sent yet. The server will try again.",
      proof:
        e.match?.frenzyOpts && e.seedParts
          ? {
              commit: e.match.frenzyOpts.commit,
              seedReveal: e.seedParts.secret.toString("hex"),
              blockhash: Buffer.from(e.seedParts.blockhash).toString("hex"),
              /** The slot of the block that blockhash belongs to: the one in which the room became active. */
              slot: e.seedParts.slot,
              jackpot: { oneIn: config.jackpotOneIn, drawn: jackpotDraw(e.seedParts.secret, e.seedParts.blockhash, roomId, config.jackpotOneIn) },
              snapshot: e.match.frenzyOpts.snapshot,
              signature: e.match.frenzyOpts.signature,
              replays: e.match.replayIndex(),
            }
          : undefined,
    };
    if (tx && e.match) this.keepReplays(roomId, e.match);
    this.broadcast(e, msg);
    this.emit("ended", msg);
    if (tx) {
      if (e.match) {
        this.keepReplays(roomId, e.match);
        const rep = this.replayStore.get(roomId) ?? new Map<string, Uint8Array>();
        void accrueRoom(roomId, e.chain.paid.filter((w) => !isBot(w)), e.chain.entryFee * BigInt(e.chain.paid.length - e.chain.passes));
        void archiveMatch({
          roomId, at: Date.now(), mode: p.mode, cluster: config.cluster, tx, entryFee: e.chain.entryFee.toString(),
          wallets: [...e.chain.paid, ...e.chain.free].filter((w) => !isBot(w)),
          hashes: [...(msg.proof?.replays ?? []).map((r: { hash: string }) => r.hash), ...(msg.proof ? [msg.proof.commit, msg.proof.snapshot.hash] : [])],
          ranking: p.result.ranking, payout: p.payout, proof: msg.proof,
        }, rep);
        addMatch(e.chain.entryFee * BigInt(e.chain.paid.length - e.chain.passes));
      }
      forgetSecret(roomId);
      if (p.mode === "royale") this.offerPasses(e, p.result.ranking.filter((r) => r.role === "paid").slice(0, 3).map((r) => r.w));
      e.pending = undefined;
      e.match = undefined;
      this.rooms.delete(roomId);
    }
  }

  /**
   * Pass rule: the top 3 of a finished room may take the tenth seat of a higher room, but ONLY when that room already has
   * 9 paid players waiting (so the seat is paid with that room's own fee and the contract can never owe more than it holds).
   * The offer is sent to the winner only; if no such room exists the winner just keeps the prize.
   */
  private offerPasses(finished: Entry, podium: string[]) {
    const tier = tierUsdOf(finished.chain.entryFee);
    const ladder = tier !== null ? config.passLadder[tier] : undefined;
    if (!ladder) return;
    podium.forEach((wallet, i) => {
      const target = ladder[i];
      const fee = target !== undefined ? feeOfTier(target) : null;
      if (fee === null) return;
      const room = [...this.rooms.values()]
        .map((x) => x.chain)
        .find((r) => r.state === "waiting" && r.mode === "royale" && r.entryFee === fee && r.paid.length === config.paidSlots - 1 && r.passes === 0 && !r.paid.includes(wallet) && !r.free.includes(wallet));
      if (!room) return;
      this.offers.set(wallet, { roomId: room.id, expires: Date.now() + config.passOfferMs, tierUsd: target, rank: i + 1 });
      for (const c of this.clients) {
        if (c.wallet === wallet) {
          send(c, { t: "passOffer", roomId: room.id, tierUsd: target, entryFee: room.entryFee.toString(), rank: i + 1, paid: room.paid.length, expiresInMs: config.passOfferMs });
        }
      }
      log("pass_offered", { wallet, roomId: room.id, tierUsd: target, rank: i + 1 });
    });
  }

  private async onAcceptPass(c: Client, roomId: string) {
    const wallet = c.wallet!;
    const offer = this.offers.get(wallet);
    if (!offer || offer.roomId !== roomId || offer.expires < Date.now()) {
      return err(c, "no_pass", "That pass is not available any more.");
    }
    this.offers.delete(wallet);
    const room = await fetchRoom(roomId);
    if (!room || room.state !== "waiting" || room.paid.length !== config.paidSlots - 1 || room.passes !== 0 || room.paid.includes(wallet)) {
      return err(c, "pass_gone", "The room filled up first. Your prize is already in your wallet.");
    }
    try {
      const tx = await joinWithPass(roomId, wallet);
      send(c, { t: "passTaken", roomId, tx });
      void this.poll();
    } catch (ex: any) {
      log("pass_failed", { roomId, error: String(ex?.message ?? ex).slice(0, 160) });
      err(c, "pass_gone", "The room filled up first. Your prize is already in your wallet.");
    }
  }

  /** A match that could not be settled for 15 minutes is refunded. Pending ones are retried every poll. */
  /**
   * A waiting room that nobody filled is not kept forever: after `roomTtlMs` from its creation (the room id carries the
   * creation time in milliseconds) it is closed on the chain, every paid entry goes back and the rent returns to the platform.
   */
  /** During the maintenance guard a room that has not started is cancelled and every entry is refunded. */
  private async drain(e: Entry): Promise<boolean> {
    if (e.offer || e.match || e.pending || e.chain.state !== "waiting") return false;
    try {
      await cancelRoom(e.chain.id, e.chain.paid, e.chain.passPlayer);
      this.broadcast(e, { t: "error", code: "maintenance_refund", message: "Scheduled maintenance is about to start: this room was cancelled and every entry refunded." });
      this.rooms.delete(e.chain.id);
      log("room_drained", { roomId: e.chain.id, paid: e.chain.paid.length });
      return true;
    } catch (ex: any) {
      log("room_drain_failed", { roomId: e.chain.id, error: String(ex?.message ?? ex).slice(0, 160) });
      return false;
    }
  }

  private async expire(e: Entry): Promise<boolean> {
    if (e.offer || e.match || e.pending || e.chain.state !== "waiting") return false;
    const createdMs = Math.floor(Number(BigInt(e.chain.id) / 1000n));
    if (!Number.isFinite(createdMs) || createdMs < 1.5e12 || Date.now() - createdMs < config.roomTtlMs) return false;
    try {
      await cancelRoom(e.chain.id, e.chain.paid, e.chain.passPlayer);
      this.broadcast(e, { t: "error", code: "room_expired", message: "The room was not filled in time and every entry was refunded." });
      this.rooms.delete(e.chain.id);
      log("room_expired", { roomId: e.chain.id, paid: e.chain.paid.length });
      return true;
    } catch (ex: any) {
      log("room_expire_failed", { roomId: e.chain.id, error: String(ex?.message ?? ex).slice(0, 160) });
      return false;
    }
  }

  private async recover(e: Entry) {
    const p = e.pending;
    if (!p || e.match?.ended === false) return;
    if (Date.now() - p.since > config.staleActiveMs) {
      try {
        await cancelRoom(e.chain.id, e.chain.paid, e.chain.passPlayer);
        e.pending = undefined;
        e.match = undefined;
        this.broadcast(e, { t: "error", code: "room_refunded", message: "The prizes could not be sent, every entry fee was refunded." });
      } catch (ex: any) {
        log("recover_failed", { roomId: e.chain.id, error: String(ex?.message ?? ex) });
      }
    } else if (Date.now() - p.since > 20_000 && p.attempts < 20) {
      await this.trySettle(e);
    }
  }
}

// ───────────── duel metadata persistence (Firestore, like the counters) ─────────────
import { firestoreBase as fsBase, firestoreReady as fsReady, firestoreToken as fsToken } from "./counters.js";

async function persistDuel(roomId: string, creator: string, max: number): Promise<void> {
  if (!fsReady()) return;
  try {
    await fetch(`${fsBase()}/duels/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await fsToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { creator: { stringValue: creator }, max: { integerValue: String(max) }, at: { integerValue: String(Date.now()) } } }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* the duel still works from memory until a restart */ }
}

async function loadDuel(roomId: string): Promise<{ creator: string; max: number } | null> {
  if (!fsReady()) return null;
  try {
    const r = await fetch(`${fsBase()}/duels/${encodeURIComponent(roomId)}`, { headers: { authorization: `Bearer ${await fsToken()}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const f = (await r.json()).fields ?? {};
    const creator = String(f.creator?.stringValue ?? "");
    const max = Number(f.max?.integerValue ?? 0);
    return creator && max >= 2 ? { creator, max } : null;
  } catch {
    return null;
  }
}
