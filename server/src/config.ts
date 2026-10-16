import { limits } from "./limits.js";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

const here = import.meta.dirname; // server/src
const serverDir = path.resolve(here, "..");
const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(serverDir, p));

const deployConfigPath = abs(process.env.DEVNET_CONFIG ?? "../devnet-config.json");
const dc = JSON.parse(fs.readFileSync(deployConfigPath, "utf8"));

const SOL = 1_000_000_000;

export const config = {
  serverDir,
  port: Number(process.env.PORT ?? 8787),
  rpcUrl: process.env.RPC_URL ?? "https://api.devnet.solana.com",
  cluster: String(dc.cluster) as string,
  programId: dc.programId as string,
  mint: dc.goshiMint as string,
  infraWallet: dc.infraWallet as string,
  liquidityWallet: dc.liquidityWallet as string,
  /** $GOSHI base units a wallet must hold to take a saboteur seat. The authority sets the same value on-chain. */
  minHolder: BigInt(process.env.MIN_HOLDER ?? dc.minHolder ?? "100000000"),
  devBots: process.env.DEV_BOTS === "1",
  /** ROOMS=0: a server of another region that only runs practice and the live arena; the rooms with entries (on chain) are run by
   *  one server only, so two servers never act on the same room. */
  rooms: process.env.ROOMS !== "0",
  /** Several regions can run rooms with entries at once: each server runs only the rooms whose id leaves this remainder when
   *  divided by REGION_COUNT, and it creates its own rooms with that remainder. So two servers never act on the same room, and
   *  anybody can tell which server runs a room from its id alone. */
  regionSlot: Number(process.env.REGION_SLOT ?? 0),
  regionCount: Math.max(1, Number(process.env.REGION_COUNT ?? 1)),
  /** Kill switch: PAUSED=1 refuses new rooms (running matches still finish and pay out). */
  paused: process.env.PAUSED === "1",
  // Rules (server/PROTOCOL.md).
  matchMs: Number(process.env.MATCH_MS ?? 300_000),
  shrinkStartMs: Number(process.env.SHRINK_START_MS ?? 120_000),
  tickRate: 20,
  practiceMs: Number(process.env.PRACTICE_MS ?? 180_000),
  practiceShrinkStartMs: Number(process.env.PRACTICE_SHRINK_MS ?? 60_000),
  maxPractice: 30,
  paidSlots: 10,
  freeSlots: 3,
  countdownMs: Number(process.env.COUNTDOWN_MS ?? 5000),
  /** Waiting time before the VS fallback is offered (5 minutes by default). */
  vsWaitMs: Number(process.env.VS_WAIT_MS ?? 300_000),
  vsOfferMs: 60_000,
  jackpotOneIn: Number(process.env.JACKPOT_ONE_IN ?? 100),
  /** Entry fees are offered in dollars and converted to SOL at the current price: from about 1 USD. */
  feeUsd: process.env.FEE_USD ? process.env.FEE_USD.split(",").map(Number).filter((n) => n > 0) : limits.sol.roomTiersUsd.filter((n) => n <= limits.sol.maxEntryUsd),
  /** Pass ladder: the finished room tier (USD) maps to the tiers its top 3 can enter without paying. */
  passLadder: { 1: [7.5, 5, 2.5] } as Record<number, number[]>,
  passOfferMs: 120_000,
  // Each open room holds ~0.0044 SOL of rent from the game key until it is closed: cap it to what that key can carry.
  maxOpenRooms: Number(process.env.MAX_OPEN_ROOMS) > 0 ? Number(process.env.MAX_OPEN_ROOMS) : 20,
  roomsPerWalletPerHour: 3,
  allowedOrigins: [
    // Local pages are accepted only off mainnet: a sign in text for "localhost" must never be valid for real funds.
    ...(String(dc.cluster) === "mainnet-beta" ? [] : ["http://localhost:4321", "http://127.0.0.1:4321"]),
    ...(process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ],
  staleActiveMs: 15 * 60 * 1000,
  /** A room that is still waiting this long after it was created is closed and every entry is refunded. */
  roomTtlMs: Number(process.env.ROOM_TTL_MS ?? 30 * 60 * 1000),
};

if (config.cluster !== "devnet" && process.env.CONFIRM_MAINNET !== "yes-really") {
  throw new Error(`Refusing to start: cluster is "${config.cluster}", this server is devnet only.`);
}
if (config.devBots && config.cluster !== "devnet") {
  throw new Error("DEV_BOTS is only allowed on devnet.");
}

/** The authority keypair. Read from disk, kept in memory, never logged. */
export function loadAuthority(): Keypair {
  const file = abs(process.env.AUTHORITY_KEYPAIR_PATH ?? "../.devnet-wallet.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/** A storage name for this network: the test network keeps the original names, every other network gets its own. Test and real
 *  data are never mixed (counters, referrals, visitors, maintenance window). */
/** An optional extra suffix (NET_SUFFIX=lab) keeps a second devnet server's counters, archive and history apart from the first one's. */
const NET_SUFFIX = process.env.NET_SUFFIX ? `-${process.env.NET_SUFFIX.replace(/[^a-z0-9]/gi, "").toLowerCase()}` : "";
export const netName = (name: string): string => (config.cluster === "devnet" ? `${name}${NET_SUFFIX}` : `${name}-${config.cluster}${NET_SUFFIX}`);

export const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

/** Whether this server runs the room with this id (see regionSlot). */
export const ownsRoom = (roomId: string | bigint): boolean => {
  if (config.regionCount <= 1) return true;
  try { return BigInt(roomId) % BigInt(config.regionCount) === BigInt(config.regionSlot); } catch { return false; }
};
/** A fresh room id that this server owns: the time in ms, then three digits chosen at random among those of this server. */
export const newOwnedRoomId = (): bigint => {
  const base = BigInt(Date.now()) * 1000n;
  const n = BigInt(config.regionCount), slot = BigInt(config.regionSlot);
  let r = BigInt(Math.floor(Math.random() * 1000));
  r -= ((base + r) % n + n - slot) % n;
  if (r < 0n) r += n;
  return base + r;
};
