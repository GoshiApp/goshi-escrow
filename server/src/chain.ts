import crypto from "node:crypto";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { config, loadAuthority, log } from "./config.js";
import { dropSecret, persistSecret } from "./secrets.js";
import { GoshiEscrow, ROOM_LEN, decodeConfig, decodeRoom, decodeVault, type Proof, type RoomAccount } from "./escrow-client.js";

export interface ChainRoom {
  id: string;
  pubkey: string;
  entryFee: bigint; // lamports
  state: "waiting" | "active";
  mode: "royale" | "vs" | "duel";
  paid: string[];
  free: string[];
  passes: number;
  passPlayer: string | null;
  /** The invited wallets of a duel (empty for other rooms). */
  guests: string[];
  /** Unix time of its creation, from the cluster clock. */
  createdAt: number;
  /** The slot in which the room became active; "0" while it waits. The seed uses the blockhash of that block. */
  activeSlot: string;
}

const authority = loadAuthority();
export const authorityPubkey = authority.publicKey;
export const connection = new Connection(config.rpcUrl, "confirmed");
export const escrow = new GoshiEscrow(new PublicKey(config.programId));
export const mint = new PublicKey(config.mint);
export { authority };

export const configPda = escrow.pda.config;
export const vaultPda = escrow.pda.vault;
export const roomPda = (id: string | bigint) => escrow.pda.room(BigInt(id));

async function send(ixs: TransactionInstruction[], signer: Keypair): Promise<string> {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
}

function toRoom(pubkey: PublicKey, a: RoomAccount): ChainRoom {
  return {
    id: a.roomId.toString(),
    pubkey: pubkey.toBase58(),
    entryFee: a.entryFee,
    state: a.state,
    mode: a.mode,
    paid: a.paid.map((p) => p.toBase58()),
    free: a.free.map((p) => p.toBase58()),
    passes: a.passes,
    passPlayer: a.passPlayer ? a.passPlayer.toBase58() : null,
    guests: a.guests.map((g) => g.toBase58()),
    createdAt: Number(a.createdAt),
    activeSlot: a.activeSlot.toString(),
  };
}

export async function listRooms(): Promise<ChainRoom[]> {
  const all = await connection.getProgramAccounts(escrow.programId, { filters: [{ dataSize: ROOM_LEN }] });
  const out: ChainRoom[] = [];
  for (const { pubkey, account } of all) {
    const r = decodeRoom(account.data);
    if (r) out.push(toRoom(pubkey, r));
  }
  return out;
}

export async function fetchRoom(id: string): Promise<ChainRoom | null> {
  const pk = roomPda(id);
  const a = await connection.getAccountInfo(pk);
  const r = a ? decodeRoom(a.data) : null;
  return r ? toRoom(pk, r) : null;
}

/** SOL waiting in the vault for the manual buy-back/burn and the super pot. */
export async function fetchVault(): Promise<{ openBurn: bigint; openJackpot: bigint; openLamports: bigint }> {
  const a = await connection.getAccountInfo(vaultPda);
  const v = a ? decodeVault(a.data) : null;
  const openBurn = v?.openBurn ?? 0n;
  const openJackpot = v?.openJackpot ?? 0n;
  return { openBurn, openJackpot, openLamports: openBurn + openJackpot };
}

/** The secret behind each room's seed commitment, kept in memory until the room is settled. */
const secrets = new Map<string, Buffer>();
export const roomSecret = (roomId: string): Buffer | undefined => secrets.get(roomId);
export const forgetSecret = (roomId: string) => { secrets.delete(roomId); void dropSecret(roomId); };

/**
 * A private duel by contract. The server builds the transaction and signs it as the authority (it pays the room's rent); the host's
 * wallet signs it and sends it, which pays the first seat and writes the invited wallets into the room. Nobody else can take a seat.
 */
export async function buildDuelTx(host: string, entryFee: bigint, guests: string[]): Promise<{ roomId: string; tx: string; commit: string }> {
  const roomId = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const secret = crypto.randomBytes(32);
  const commit = crypto.createHash("sha256").update(secret).digest();
  secrets.set(roomId, secret);
  void persistSecret(roomId, secret);
  const ix = escrow.createDuel(authority.publicKey, new PublicKey(host), BigInt(roomId), entryFee, commit, guests.map((g) => new PublicKey(g)));
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: authority.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.partialSign(authority);
  log("duel_tx_built", { roomId, host: host.slice(0, 6), guests: guests.length, entryFee: entryFee.toString() });
  return { roomId, tx: tx.serialize({ requireAllSignatures: false }).toString("base64"), commit: commit.toString("hex") };
}

export async function createRoom(entryFee: bigint): Promise<{ roomId: string; tx: string; commit: string }> {
  const roomId = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  // Commit now (before anybody joins), reveal when the match closes: seed = sha256(secret, blockhash, room id).
  const secret = crypto.randomBytes(32);
  const commit = crypto.createHash("sha256").update(secret).digest();
  secrets.set(roomId, secret);
  void persistSecret(roomId, secret);
  const tx = await send([escrow.createRoom(authority.publicKey, BigInt(roomId), entryFee, commit)], authority);
  log("room_created", { roomId, entryFee: entryFee.toString(), tx, commit: commit.toString("hex") });
  return { roomId, tx, commit: commit.toString("hex") };
}

/** The newest confirmed blockhash: unknown when the room was created, so the server cannot choose the seed in advance. */
export async function currentBlockhash(): Promise<Uint8Array> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  return bs58.decode(blockhash);
}

/** A $GOSHI token account of this owner: the associated one if it exists, otherwise the biggest. */
export async function findTokenAccount(owner: PublicKey): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    if (res.value.length === 0) throw new Error(`no $GOSHI token account for ${owner.toBase58()}`);
    res.value.sort((a, b) => Number(BigInt(b.account.data.parsed.info.tokenAmount.amount) - BigInt(a.account.data.parsed.info.tokenAmount.amount)));
    return res.value[0].pubkey;
  }
}

export async function ensureTokenAccount(owner: PublicKey): Promise<PublicKey> {
  return (await getOrCreateAssociatedTokenAccount(connection, authority, mint, owner)).address;
}

export async function mintTestTokens(to: PublicKey, amount: bigint): Promise<string> {
  const ata = await ensureTokenAccount(to);
  return mintTo(connection, authority, mint, ata, authority, amount);
}

export async function tokenBalance(account: PublicKey): Promise<bigint> {
  return (await getAccount(connection, account)).amount;
}

export async function goshiBalanceOf(owner: PublicKey): Promise<bigint> {
  try {
    return await tokenBalance(await findTokenAccount(owner));
  } catch {
    return 0n;
  }
}

export async function joinPaidAs(player: Keypair, roomId: string): Promise<string> {
  return send([escrow.joinRoom(player.publicKey, BigInt(roomId))], player);
}

export async function joinFreeAs(player: Keypair, roomId: string): Promise<string> {
  const playerToken = await findTokenAccount(player.publicKey);
  return send([escrow.joinFree(player.publicKey, BigInt(roomId), playerToken)], player);
}

export async function startVs(roomId: string): Promise<string> {
  const tx = await send([escrow.startVs(authority.publicKey, BigInt(roomId))], authority);
  log("vs_started", { roomId, tx });
  return tx;
}

export async function startDuel(roomId: string): Promise<string> {
  const tx = await send([escrow.startDuel(authority.publicKey, BigInt(roomId))], authority);
  log("duel_started", { roomId, tx });
  return tx;
}

export async function finalizeDuel(roomId: string, winner: string, proof?: Proof): Promise<string> {
  const tx = await send(
    [escrow.finalizeDuel(authority.publicKey, BigInt(roomId), new PublicKey(config.infraWallet), new PublicKey(config.liquidityWallet), new PublicKey(winner), proof)],
    authority
  );
  log("duel_finalized", { roomId, winner, tx });
  return tx;
}

/** Podium: paid players only, in rank order. Saboteurs are paid their share from the same instruction. */
export async function finalizeRoyale(roomId: string, podium: string[], saboteurs: string[], proof?: Proof): Promise<string> {
  if (podium.length !== 3) throw new Error("the podium needs 3 players");
  const tx = await send(
    [
      escrow.finalizeRoyale(
        authority.publicKey,
        BigInt(roomId),
        new PublicKey(config.infraWallet),
        new PublicKey(config.liquidityWallet),
        podium.map((w) => new PublicKey(w)),
        saboteurs.map((w) => new PublicKey(w)),
        proof
      ),
    ],
    authority
  );
  log("royale_finalized", { roomId, podium, saboteurs: saboteurs.length, tx });
  return tx;
}

/** Seats a pass winner as the 10th paid player of a room that already has 9. Nothing is charged. */
export async function joinWithPass(roomId: string, holder: string): Promise<string> {
  const tx = await send([escrow.joinWithPass(authority.publicKey, new PublicKey(holder), BigInt(roomId))], authority);
  log("pass_seat", { roomId, holder, tx });
  return tx;
}

export async function finalizeVs(roomId: string, ranking: string[], proof?: Proof): Promise<string> {
  const tx = await send(
    [
      escrow.finalizeVs(
        authority.publicKey,
        BigInt(roomId),
        new PublicKey(config.infraWallet),
        new PublicKey(config.liquidityWallet),
        ranking.map((w) => new PublicKey(w)),
        proof
      ),
    ],
    authority
  );
  log("vs_finalized", { roomId, ranking, tx });
  return tx;
}

export async function cancelRoom(roomId: string, paid: string[], passPlayer: string | null = null): Promise<string> {
  // A pass holder paid nothing, so it is not refunded and its wallet is not passed.
  const refunds = paid.filter((w) => w !== passPlayer).map((w) => new PublicKey(w));
  const tx = await send([escrow.cancelRoom(authority.publicKey, BigInt(roomId), refunds)], authority);
  log("room_cancelled", { roomId, tx });
  return tx;
}

/**
 * The blockhash of the block in which a room became active. Nobody knows it before the transaction that fills the room is sent,
 * so the seed cannot be steered, and anybody can read the same block later. Fails (never falls back to something else).
 */
export async function blockhashOfSlot(slot: bigint): Promise<Uint8Array> {
  let last = "";
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlock", params: [Number(slot), { commitment: "confirmed", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }] }),
        signal: AbortSignal.timeout(8000),
      });
      const j: any = await r.json();
      const h = j?.result?.blockhash;
      if (typeof h === "string") return bs58.decode(h);
      last = String(j?.error?.message ?? "no block").slice(0, 80);
    } catch (e: any) {
      last = String(e?.message ?? e).slice(0, 80);
    }
    await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
  }
  throw new Error(`the block of slot ${slot} is not available: ${last}`);
}

/**
 * The upgrade authority of the program (BPF upgradeable loader), or null when it is immutable. Used to refuse to run on mainnet
 * with the same key as the game authority.
 */
export async function upgradeAuthorityOf(programId: PublicKey): Promise<PublicKey | null | undefined> {
  const prog = await connection.getAccountInfo(programId);
  if (!prog || prog.data.length < 36 || prog.data.readUInt32LE(0) !== 2) return undefined;
  const pd = await connection.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
  if (!pd || pd.data.length < 45 || pd.data.readUInt32LE(0) !== 3) return undefined;
  return pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
}

/** The roles recorded in the program's configuration on chain. */
export async function onChainRoles(): Promise<{ authority: PublicKey; guardian: PublicKey } | null> {
  const a = await connection.getAccountInfo(configPda);
  const c = a ? decodeConfig(a.data) : null;
  return c ? { authority: c.authority, guardian: c.guardian } : null;
}
