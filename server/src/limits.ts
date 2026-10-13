// Everything that can be raised as the platform proves itself, in one place and without touching code: the amounts a room
// or a duel may have, and how much one wallet may do. The soft launch values are the defaults. To move to the next stage
// set LIMITS_JSON (a partial object, merged over these) and redeploy the server. The program itself accepts entries up to
// 1,000,000 SOL, so raising a limit here never needs a program upgrade.
//
// The operators move between stages with LIMITS_JSON, one step at a time.
// $GOSHI rooms need an SPL escrow in the program: the structure below is ready, `goshi.enabled` stays false until then.
export interface Limits {
  stage: string;
  sol: {
    roomTiersUsd: number[];
    duelTiersUsd: number[];
    /** Hard ceiling for any entry in USD, checked on top of the tiers (a tier above it is ignored). */
    maxEntryUsd: number;
    duelPlayers: [number, number];
    maxOpenDuelsPerWallet: number;
    maxDuelsPerWalletPerHour: number;
    /** Total entries one wallet may put into rooms and duels in 24 hours (USD). 0 = no limit. */
    maxDailyEntryUsdPerWallet: number;
  };
  goshi: { enabled: boolean; mint: string | null; decimals: number; tiers: number[]; maxEntry: number };
  duel: { rakePct: number; maxMinutes: number; joinWindowMinutes: number };
}

export const DEFAULT_LIMITS: Limits = {
  stage: "soft-launch",
  sol: {
    roomTiersUsd: [1, 2.5, 5],
    duelTiersUsd: [1, 2.5, 5],
    maxEntryUsd: 5,
    duelPlayers: [2, 5],
    maxOpenDuelsPerWallet: 3,
    maxDuelsPerWalletPerHour: 10,
    maxDailyEntryUsdPerWallet: 100,
  },
  goshi: { enabled: false, mint: null, decimals: 6, tiers: [], maxEntry: 0 },
  duel: { rakePct: 3, maxMinutes: 10, joinWindowMinutes: 30 },
};

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== "object" || Array.isArray(over)) return (over === undefined ? base : (over as T));
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

export function loadLimits(raw: string | undefined = process.env.LIMITS_JSON): Limits {
  if (!raw) return DEFAULT_LIMITS;
  try {
    return merge(DEFAULT_LIMITS, JSON.parse(raw));
  } catch {
    return DEFAULT_LIMITS;
  }
}

export const limits: Limits = loadLimits();

/** True when a USD tier is allowed for duels under the current limits. */
export const duelTierAllowed = (usd: number | null): boolean =>
  usd !== null && limits.sol.duelTiersUsd.includes(usd) && usd <= limits.sol.maxEntryUsd;
