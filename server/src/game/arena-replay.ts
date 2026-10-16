// The record of a whole arena match: who was in it, with what mass, and every change of steering and boost of every player.
// With the seed (committed on chain) the match can be played again step by step and must end in the same ranking, so
// "everything that happened" is fixed by one hash that the closing transaction writes to the chain log.
//
// Format "GA\x01" (rules 1) or "GA\x02" (rules 2): the last byte of the magic is the version of the rules the match was played with.
// Layout: seed u32 | matchMs u32 | shrinkStartMs u32 | nPlayers u8 |
//   per player: wallet length u8, wallet bytes, role u8 (0 paid, 1 saboteur), bot u8, start mass u16 (x10) |
//   nEntries u32 | per entry: tick u16, player index u8, angle u8, boost u8.
import { createHash } from "node:crypto";
import { Arena, AWAY_PROTECT_S, BACK_PROTECT_S, RULES_NOW, rulesActive, setRules, type Role, type RulesVersion } from "./arena.js";

export interface ArenaRecordPlayer { w: string; n: string; role: Role; bot: boolean; m: number }

export function encodeArenaReplay(
  seed: number, matchMs: number, shrinkStartMs: number, players: readonly ArenaRecordPlayer[], log: readonly [number, number, number, number][],
  rules: RulesVersion = RULES_NOW,
): Uint8Array {
  const names = players.map((p) => Buffer.from(p.w, "utf8"));
  const size = 3 + 12 + 1 + players.reduce((a, _p, i) => a + 1 + names[i].length + 4, 0) + 4 + log.length * 5;
  const b = Buffer.alloc(size);
  let o = 0;
  b.write(rules === 1 ? "GA\x01" : "GA\x02", o, "latin1"); o += 3;
  b.writeUInt32BE(seed >>> 0, o); o += 4;
  b.writeUInt32BE(matchMs >>> 0, o); o += 4;
  b.writeUInt32BE(shrinkStartMs >>> 0, o); o += 4;
  b.writeUInt8(players.length, o++);
  players.forEach((p, i) => {
    b.writeUInt8(names[i].length, o++);
    names[i].copy(b, o); o += names[i].length;
    b.writeUInt8(p.role === "saboteur" ? 1 : 0, o++);
    b.writeUInt8(p.bot ? 1 : 0, o++);
    b.writeUInt16BE(Math.round(p.m * 10), o); o += 2;
  });
  b.writeUInt32BE(log.length, o); o += 4;
  for (const [t, i, a, f] of log) {
    b.writeUInt16BE(t, o); o += 2;
    b.writeUInt8(i, o++);
    b.writeUInt8(a, o++);
    b.writeUInt8(f, o++);
  }
  return new Uint8Array(b.buffer, b.byteOffset, o);
}

export function decodeArenaReplay(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  const magic = b.toString("latin1", 0, 3);
  if (magic !== "GA\x01" && magic !== "GA\x02") throw new Error("not an arena record");
  const rules: RulesVersion = magic === "GA\x01" ? 1 : 2;
  let o = 3;
  const seed = b.readUInt32BE(o); o += 4;
  const matchMs = b.readUInt32BE(o); o += 4;
  const shrinkStartMs = b.readUInt32BE(o); o += 4;
  const n = b.readUInt8(o++);
  const players: ArenaRecordPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const len = b.readUInt8(o++);
    const w = b.toString("utf8", o, o + len); o += len;
    const role: Role = b.readUInt8(o++) === 1 ? "saboteur" : "paid";
    const bot = b.readUInt8(o++) === 1;
    const m = b.readUInt16BE(o) / 10; o += 2;
    players.push({ w, n: w, role, bot, m });
  }
  const count = b.readUInt32BE(o); o += 4;
  const log: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    log.push([b.readUInt16BE(o), b.readUInt8(o + 2), b.readUInt8(o + 3), b.readUInt8(o + 4)]);
    o += 5;
  }
  return { seed, matchMs, shrinkStartMs, players, log, rules };
}

export const arenaReplayHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Plays a record again from nothing but the file. Returns the finished arena (compare ranking and masses with the original). */
export function replayArena(bytes: Uint8Array): Arena {
  const r = decodeArenaReplay(bytes);
  const before = rulesActive();
  const arena = new Arena(r.seed, r.players, { matchMs: r.matchMs, shrinkStartMs: r.shrinkStartMs, rules: r.rules });
  r.players.forEach((p, i) => { arena.players[i].m = p.m; arena.players[i].peak = p.m; });
  const STEP = 1 / 20;
  let k = 0;
  for (let tick = 0; !arena.finished() && arena.time * 1000 < r.matchMs; tick++) {
    while (k < r.log.length && r.log[k][0] === tick) {
      const [, pi, ab, f] = r.log[k++];
      const p = arena.players[pi];
      // Flags 2 and 3 are not steering: the connection dropped (the bot plays, protected) or came back (a few seconds of protection).
      if (f === 2 || f === 3) { p.auto = f === 2; p.protectUntil = Math.max(p.protectUntil, arena.time + (f === 3 ? BACK_PROTECT_S : AWAY_PROTECT_S)); continue; }
      const hd = (ab / 256) * Math.PI * 2;
      p.dx = Math.cos(hd);
      p.dy = Math.sin(hd);
      p.boost = f === 1;
    }
    arena.step(STEP); // no brain: the inputs come from the record
  }
  setRules(before);
  return arena;
}
