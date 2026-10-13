// Client for the native goshi-escrow program: PDAs, instruction builders and account decoders.
// No framework: plain bytes, the same layout as native/src/lib.rs. Works in Node and in the browser.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export const MAX_PAID = 10;
export const MAX_FREE = 3;
export const CONFIG_LEN = 172;
export const LEGACY_CONFIG_LEN = 140;
export const ROOM_LEN = 487;
export const VAULT_LEN = 18;

const u64 = (n: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function pdas(programId: PublicKey) {
  return {
    config: PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], programId)[0],
    vault: PublicKey.findProgramAddressSync([new TextEncoder().encode("vault")], programId)[0],
    room: (id: bigint | number) =>
      PublicKey.findProgramAddressSync([new TextEncoder().encode("room"), u64(id)], programId)[0],
  };
}

const ix = (programId: PublicKey, keys: { pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }[], data: Uint8Array) =>
  new TransactionInstruction({
    programId,
    keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable })),
    data: Buffer.from(data),
  });

/** What a match leaves on the chain as a log (no account): the revealed secret, the blockhash used, the price snapshot and the replay root. */
export interface Proof {
  seedReveal: Uint8Array;
  blockhash: Uint8Array;
  snapshotHash: Uint8Array;
  replayRoot: Uint8Array;
}
const proofBytes = (p?: Proof): Uint8Array[] => {
  if (!p) return [];
  for (const k of [p.seedReveal, p.blockhash, p.snapshotHash, p.replayRoot]) if (k.length !== 32) throw new Error("each proof part is 32 bytes");
  return [p.seedReveal, p.blockhash, p.snapshotHash, p.replayRoot];
};

export class GoshiEscrow {
  readonly programId: PublicKey;
  readonly pda: ReturnType<typeof pdas>;
  constructor(programId: PublicKey) {
    this.programId = programId;
    this.pda = pdas(programId);
  }

  /** `guardian`: the cold key (or multisig) that controls the house wallets, the vault and the settings. Default: the authority itself. */
  initialize(authority: PublicKey, infra: PublicKey, liquidity: PublicKey, mint: PublicKey, minHolder: bigint, requiredSaboteurs: number, guardian?: PublicKey) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: this.pda.config, isWritable: true },
        { pubkey: this.pda.vault, isWritable: true },
        { pubkey: infra },
        { pubkey: liquidity },
        { pubkey: mint },
        { pubkey: SystemProgram.programId },
      ],
      cat(Uint8Array.of(0), u64(minHolder), Uint8Array.of(requiredSaboteurs), ...(guardian ? [guardian.toBytes()] : []))
    );
  }

  /** Settings are the guardian's. */
  setMinHolder(guardian: PublicKey, amount: bigint) {
    return ix(this.programId, [{ pubkey: guardian, isSigner: true }, { pubkey: this.pda.config, isWritable: true }], cat(Uint8Array.of(1), u64(amount)));
  }

  setRequiredSaboteurs(guardian: PublicKey, n: number) {
    return ix(this.programId, [{ pubkey: guardian, isSigner: true }, { pubkey: this.pda.config, isWritable: true }], Uint8Array.of(2, n));
  }

  /** `commit`: optional 32 byte seed commitment, logged by the program (nothing is stored). */
  createRoom(authority: PublicKey, roomId: bigint | number, entryFee: bigint, commit?: Uint8Array) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: SystemProgram.programId },
      ],
      cat(Uint8Array.of(3), u64(roomId), u64(entryFee), ...(commit ? [commit] : []))
    );
  }

  joinRoom(player: PublicKey, roomId: bigint | number) {
    return ix(
      this.programId,
      [
        { pubkey: player, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: SystemProgram.programId },
      ],
      cat(Uint8Array.of(4), u64(roomId))
    );
  }

  joinFree(player: PublicKey, roomId: bigint | number, playerToken: PublicKey) {
    return ix(
      this.programId,
      [
        { pubkey: player, isSigner: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: playerToken },
      ],
      cat(Uint8Array.of(5), u64(roomId))
    );
  }

  joinWithPass(authority: PublicKey, holder: PublicKey, roomId: bigint | number) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true },
        { pubkey: holder },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
      ],
      cat(Uint8Array.of(6), u64(roomId))
    );
  }

  startVs(authority: PublicKey, roomId: bigint | number) {
    return ix(
      this.programId,
      [{ pubkey: authority, isSigner: true }, { pubkey: this.pda.config }, { pubkey: this.pda.room(roomId), isWritable: true }],
      Uint8Array.of(7)
    );
  }

  /**
   * A private duel by contract: the host signs and pays the first seat, and only `guests` (1 to 4 wallets) can take the others.
   * The authority pays the room's rent and signs too.
   */
  createDuel(authority: PublicKey, host: PublicKey, roomId: bigint | number, entryFee: bigint, commit: Uint8Array, guests: PublicKey[]) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: host, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: SystemProgram.programId },
      ],
      cat(Uint8Array.of(16), u64(roomId), u64(entryFee), commit, Uint8Array.of(guests.length), ...guests.map((g) => g.toBytes()))
    );
  }

  /** Hands the game authority to another key. The guardian and the new key sign: a lost or stolen hot key is replaced without it. */
  setAuthority(guardian: PublicKey, newAuthority: PublicKey) {
    return ix(
      this.programId,
      [{ pubkey: guardian, isSigner: true }, { pubkey: newAuthority, isSigner: true }, { pubkey: this.pda.config, isWritable: true }],
      Uint8Array.of(14)
    );
  }

  /** Changes the infrastructure and liquidity wallets that receive their share of the fee (guardian only). */
  setWallets(guardian: PublicKey, infra: PublicKey, liquidity: PublicKey) {
    return ix(
      this.programId,
      [{ pubkey: guardian, isSigner: true }, { pubkey: this.pda.config, isWritable: true }],
      cat(Uint8Array.of(15), infra.toBytes(), liquidity.toBytes())
    );
  }

  /** Hands the guardian role to another key. The current guardian and the new one sign. */
  setGuardian(guardian: PublicKey, newGuardian: PublicKey) {
    return ix(
      this.programId,
      [{ pubkey: guardian, isSigner: true }, { pubkey: newGuardian, isSigner: true }, { pubkey: this.pda.config, isWritable: true }],
      Uint8Array.of(18)
    );
  }

  /** Moves a v4 config (140 bytes) to the v5 layout and names the guardian. The stored authority and the guardian sign. */
  migrateConfig(authority: PublicKey, newGuardian: PublicKey) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: newGuardian, isSigner: true },
        { pubkey: this.pda.config, isWritable: true },
        { pubkey: SystemProgram.programId },
      ],
      Uint8Array.of(19)
    );
  }

  /**
   * Anybody may call it once the room is old enough (3 hours) and still not settled: every paid wallet gets its entry back and
   * the rent returns to the authority. `refunds`: the room's paid wallets in room order, a pass holder skipped.
   */
  refundExpired(caller: PublicKey, roomId: bigint | number, authority: PublicKey, refunds: PublicKey[]) {
    return ix(
      this.programId,
      [
        { pubkey: caller, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: authority, isWritable: true },
        ...refunds.map((pubkey) => ({ pubkey, isWritable: true })),
      ],
      Uint8Array.of(17)
    );
  }

  /** A duel: 2 to 5 paid players, no saboteurs. */
  startDuel(authority: PublicKey, roomId: bigint | number) {
    return ix(
      this.programId,
      [{ pubkey: authority, isSigner: true }, { pubkey: this.pda.config }, { pubkey: this.pda.room(roomId), isWritable: true }],
      Uint8Array.of(12)
    );
  }

  /** The winner takes the pot minus the 3 percent house fee. */
  finalizeDuel(authority: PublicKey, roomId: bigint | number, infra: PublicKey, liquidity: PublicKey, winner: PublicKey, proof?: Proof) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: this.pda.vault, isWritable: true },
        { pubkey: infra, isWritable: true },
        { pubkey: liquidity, isWritable: true },
        { pubkey: winner, isWritable: true },
      ],
      cat(Uint8Array.of(13), winner.toBytes(), ...proofBytes(proof))
    );
  }

  /** `podium`: three paid wallets in rank order. `saboteurs`: the room's saboteur wallets in room order. */
  finalizeRoyale(authority: PublicKey, roomId: bigint | number, infra: PublicKey, liquidity: PublicKey, podium: PublicKey[], saboteurs: PublicKey[], proof?: Proof) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: this.pda.vault, isWritable: true },
        { pubkey: infra, isWritable: true },
        { pubkey: liquidity, isWritable: true },
        ...[...podium, ...saboteurs].map((pubkey) => ({ pubkey, isWritable: true })),
      ],
      cat(Uint8Array.of(8), ...podium.map((p) => p.toBytes()), ...proofBytes(proof))
    );
  }

  finalizeVs(authority: PublicKey, roomId: bigint | number, infra: PublicKey, liquidity: PublicKey, ranking: PublicKey[], proof?: Proof) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        { pubkey: this.pda.vault, isWritable: true },
        { pubkey: infra, isWritable: true },
        { pubkey: liquidity, isWritable: true },
        ...ranking.map((pubkey) => ({ pubkey, isWritable: true })),
      ],
      cat(Uint8Array.of(9, ranking.length), ...ranking.map((p) => p.toBytes()), ...proofBytes(proof))
    );
  }

  /** `paid`: the room's paid wallets in room order; a pass holder is skipped (it paid nothing). */
  cancelRoom(authority: PublicKey, roomId: bigint | number, refunds: PublicKey[]) {
    return ix(
      this.programId,
      [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.room(roomId), isWritable: true },
        ...refunds.map((pubkey) => ({ pubkey, isWritable: true })),
      ],
      Uint8Array.of(10)
    );
  }

  /** The guardian takes what the vault holds (never more than it tracks as pending). */
  withdrawVault(guardian: PublicKey, destination: PublicKey, amount: bigint) {
    return ix(
      this.programId,
      [
        { pubkey: guardian, isSigner: true },
        { pubkey: this.pda.config },
        { pubkey: this.pda.vault, isWritable: true },
        { pubkey: destination, isWritable: true },
      ],
      cat(Uint8Array.of(11), u64(amount))
    );
  }
}

// ───────────── decoders ─────────────
const key = (d: Uint8Array, o: number) => new PublicKey(d.slice(o, o + 32));
const rdU64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

export interface ConfigAccount {
  authority: PublicKey;
  /** The cold key: house wallets, vault, settings, replacing the authority. */
  guardian: PublicKey;
  infraWallet: PublicKey;
  liquidityWallet: PublicKey;
  mint: PublicKey;
  minHolder: bigint;
  requiredSaboteurs: number;
}
export function decodeConfig(d: Uint8Array): ConfigAccount | null {
  if (d.length !== CONFIG_LEN || d[0] !== 1) return null;
  return {
    authority: key(d, 1),
    guardian: key(d, 140),
    infraWallet: key(d, 33),
    liquidityWallet: key(d, 65),
    mint: key(d, 97),
    minHolder: rdU64(d, 129),
    requiredSaboteurs: d[137],
  };
}

export interface RoomAccount {
  roomId: bigint;
  entryFee: bigint;
  state: "waiting" | "active";
  mode: "royale" | "vs" | "duel";
  paid: PublicKey[];
  free: PublicKey[];
  passes: number;
  passPlayer: PublicKey | null;
  /** The invited wallets of a duel (empty for any other room). */
  guests: PublicKey[];
  /** Unix time of the creation of the room (the cluster clock). */
  createdAt: bigint;
  /** The slot in which the room became active: the seed of the match uses the blockhash of that block. 0n while waiting. */
  activeSlot: bigint;
}
export function decodeRoom(d: Uint8Array): RoomAccount | null {
  if (d.length !== ROOM_LEN || d[0] !== 2) return null;
  const pn = d[19];
  const fn = d[20];
  const paid: PublicKey[] = [];
  const free: PublicKey[] = [];
  for (let i = 0; i < Math.min(pn, MAX_PAID); i++) paid.push(key(d, 55 + 32 * i));
  for (let i = 0; i < Math.min(fn, MAX_FREE); i++) free.push(key(d, 375 + 32 * i));
  return {
    roomId: rdU64(d, 1),
    entryFee: rdU64(d, 9),
    state: d[17] === 1 ? "active" : "waiting",
    mode: d[18] === 2 ? "duel" : d[18] === 1 ? "vs" : "royale",
    paid,
    free,
    passes: d[21],
    passPlayer: d[21] > 0 ? key(d, 23) : null,
    guests: d[18] === 2
      ? [key(d, 375), key(d, 407), key(d, 439), key(d, 23)].filter((k) => !k.equals(PublicKey.default))
      : [],
    createdAt: rdU64(d, 471),
    activeSlot: rdU64(d, 479),
  };
}

export interface VaultAccount {
  openBurn: bigint;
  openJackpot: bigint;
}
export function decodeVault(d: Uint8Array): VaultAccount | null {
  if (d.length !== VAULT_LEN || d[0] !== 3) return null;
  return { openBurn: rdU64(d, 1), openJackpot: rdU64(d, 9) };
}

/** Error codes of the program (custom program error numbers). */
export const ERRORS: Record<number, string> = {
  6000: "Unauthorized", 6001: "InvalidEntryFee", 6002: "RoomMismatch", 6003: "RoomNotWaiting", 6004: "RoomNotActive",
  6005: "RoomFull", 6006: "AlreadyJoined", 6007: "NotEnoughGoshi", 6008: "BadPlayerCount", 6009: "DuplicateWinners",
  6010: "WinnerNotInRoom", 6011: "WrongAccount", 6012: "BadAccounts", 6013: "MathOverflow", 6014: "NothingPending",
  6015: "BadAccountData", 6016: "AlreadyInitialized", 6017: "BadInstruction", 6018: "TooEarly",
};
