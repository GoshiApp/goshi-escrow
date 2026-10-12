// Settlement rules for a room, in lamports (integer math, every part is accounted for, remainders go to a stated bucket).
// Pure functions: no network, no chain. The on-chain program and the swap step must implement exactly these numbers.
//
// Two modes:
//  * "royale": paid players (SOL) and up to 3 free players. Top 3 share 90% of the pot as 60/25/15. A free player on the
//    podium receives at most 0.2% of the whole pot, always paid in $GOSHI. What a free player does not take is unclaimed.
//  * "vs": 2 to 9 paid players, no free players. The 10% rake is taken from every entry; everyone but the winner keeps 80%
//    of their net entry and the winner takes the rest (120% of the net entry when there are two players).
//
// Rake (10% of the pot, remainder to the jackpot): 10% buy-back and burn, 15% infrastructure, 25% liquidity and community
// treasury, 50% rollover jackpot ($GOSHI).
// Unclaimed pool (SOL that no paid player takes): swapped to $GOSHI, 1% burned and 99% to the jackpot.

export const RAKE_PCT = 10n;
export const PRIZE_SPLIT_PCT = [60n, 25n, 15n] as const; // of the prize pool
export const RAKE_SPLIT_PCT = { buybackBurn: 10n, infra: 15n, liquidity: 25n } as const; // jackpot = remainder
export const FREE_CAP_PER_MILLE = 2n; // 0.2% of the whole pot, in thousandths
export const UNCLAIMED_BURN_PCT = 1n;
export const VS_LOSER_KEEPS_PCT = 80n; // of the net entry

export interface Podium {
  wallet: string;
  free: boolean;
}

const pct = (a: bigint, p: bigint) => (a * p) / 100n;

function rakeSplit(rake: bigint) {
  const buybackBurn = pct(rake, RAKE_SPLIT_PCT.buybackBurn);
  const infra = pct(rake, RAKE_SPLIT_PCT.infra);
  const liquidity = pct(rake, RAKE_SPLIT_PCT.liquidity);
  return { buybackBurn, infra, liquidity, jackpot: rake - buybackBurn - infra - liquidity };
}

function finish(s: Omit<Settlement, "swapToGoshi" | "keptInSol">): Settlement {
  const swapToGoshi = s.rakeParts.buybackBurn + s.rakeParts.jackpot + s.unclaimed;
  const keptInSol = s.payouts.filter((p) => p.kind === "sol").reduce((a, p) => a + p.lamports, 0n) + s.rakeParts.infra + s.rakeParts.liquidity;
  const out = { ...s, swapToGoshi, keptInSol };
  if (swapToGoshi + keptInSol !== s.pot) throw new Error("settlement does not add up");
  return out;
}

export interface RoyaleSettlement {
  nominal: bigint;
  cash: bigint;
  /** Top 3 paid players, in rank order. */
  prizes: [bigint, bigint, bigint];
  saboteurEach: bigint;
  saboteurTotal: bigint;
  /** What the house keeps: cash minus prizes minus the saboteur pool (exactly 10 percent of the nominal pot without a pass seat). */
  rake: bigint;
  rakeParts: { buybackBurn: bigint; infra: bigint; liquidity: bigint; jackpot: bigint };
}

export const PRIZE_POOL_PCT = 88n;
export const SABOTEUR_POOL_PCT = 2n;

/**
 * Royale room with saboteurs. `nominal` is the entry fee times the paid seats (a pass seat counts), `cash` is what the
 * room really holds. Prizes: 88 percent of the nominal pot, 60/25/15 (third is the remainder). Saboteurs: 2 percent split
 * equally among the seated ones (dust and an unused pool go to the house). The house keeps the rest of the cash.
 * Mirrors programs/goshi-escrow/src/lib.rs `settle_royale`. Returns null when the cash cannot cover the obligations.
 */
export function settleRoyale(nominal: bigint, cash: bigint, saboteurs: number): RoyaleSettlement | null {
  const prizePool = pct(nominal, PRIZE_POOL_PCT);
  const first = pct(prizePool, PRIZE_SPLIT_PCT[0]);
  const second = pct(prizePool, PRIZE_SPLIT_PCT[1]);
  const third = prizePool - first - second;
  const sabPool = pct(nominal, SABOTEUR_POOL_PCT);
  const n = BigInt(saboteurs);
  const saboteurEach = n === 0n ? 0n : sabPool / n;
  const saboteurTotal = saboteurEach * n;
  const rake = cash - prizePool - saboteurTotal;
  if (rake < 0n) return null;
  return { nominal, cash, prizes: [first, second, third], saboteurEach, saboteurTotal, rake, rakeParts: rakeSplit(rake) };
}

export type Payout =
  | { wallet: string; rank: number; kind: "sol"; lamports: bigint }
  | { wallet: string; rank: number; kind: "goshi"; lamports: bigint };

export interface Settlement {
  mode: "royale" | "vs";
  pot: bigint;
  rake: bigint;
  rakeParts: { buybackBurn: bigint; infra: bigint; liquidity: bigint; jackpot: bigint };
  payouts: Payout[];
  unclaimed: bigint;
  unclaimedParts: { burn: bigint; jackpot: bigint };
  swapToGoshi: bigint;
  keptInSol: bigint;
}

/** VS room: 2 to 9 paid players with equal entries, no free players. `ranking[0]` is the winner. */
export function settleVs(entry: bigint, ranking: string[]): Settlement {
  const n = BigInt(ranking.length);
  if (n < 2n || n > 9n) throw new Error("VS mode is for 2 to 9 players");
  const pot = entry * n;
  const rake = pct(pot, RAKE_PCT);
  const net = entry - pct(entry, RAKE_PCT); // net entry of one player after the rake
  const loserGets = pct(net, VS_LOSER_KEEPS_PCT);
  const payouts: Payout[] = [];
  let losersTotal = 0n;
  for (let i = 1; i < ranking.length; i++) {
    payouts.push({ wallet: ranking[i], rank: i + 1, kind: "sol", lamports: loserGets });
    losersTotal += loserGets;
  }
  // The winner takes everything left after the rake and the 80% the others keep (120% of the net entry with two players).
  const winner = pot - rake - losersTotal;
  payouts.unshift({ wallet: ranking[0], rank: 1, kind: "sol", lamports: winner });
  return finish({ mode: "vs", pot, rake, rakeParts: rakeSplit(rake), payouts, unclaimed: 0n, unclaimedParts: { burn: 0n, jackpot: 0n } });
}
