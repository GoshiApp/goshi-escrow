import test from "node:test";
import assert from "node:assert/strict";
import { settleRoyale, settleVs } from "../src/game/settlement.ts";

const SOL = 1_000_000_000n;
const sol = (s: any, w: string) => s.payouts.find((p: any) => p.wallet === w && p.kind === "sol")?.lamports ?? 0n;
const sumPrizes = (s: NonNullable<ReturnType<typeof settleRoyale>>) => s.prizes[0] + s.prizes[1] + s.prizes[2];

test("a one dollar like room: 88% to the Top 3, 2% to the three saboteurs, 10% to the house", () => {
  const nominal = 10n * SOL;
  const s = settleRoyale(nominal, nominal, 3)!;
  assert.deepEqual(s.prizes, [5_280_000_000n, 2_200_000_000n, 1_320_000_000n]);
  assert.equal(s.saboteurEach, 66_666_666n);
  assert.equal(s.saboteurTotal, 199_999_998n);
  assert.equal(sumPrizes(s) + s.saboteurTotal + s.rake, nominal);
  assert.equal(s.rake, 1_000_000_002n);
});

test("rake split of the house share: 10 burn, 15 infrastructure, 25 liquidity, rest jackpot", () => {
  const s = settleRoyale(10n * SOL, 10n * SOL, 0)!;
  assert.equal(s.saboteurTotal, 0n);
  assert.equal(s.rake, 1_200_000_000n); // the unused saboteur pool goes to the house
  assert.equal(s.rakeParts.buybackBurn + s.rakeParts.infra + s.rakeParts.liquidity + s.rakeParts.jackpot, s.rake);
  assert.equal(s.rakeParts.buybackBurn, 120_000_000n);
  assert.equal(s.rakeParts.infra, 180_000_000n);
  assert.equal(s.rakeParts.liquidity, 300_000_000n);
});

test("a pass seat: the room is solvent and the house forgoes (almost) its whole fee", () => {
  const fee = 7_500_000_000n;
  const s = settleRoyale(fee * 10n, fee * 9n, 3)!;
  assert.equal(sumPrizes(s) + s.saboteurTotal + s.rake, fee * 9n);
  assert.ok(s.rake <= 3n, `rake ${s.rake}`);
});

test("two pass seats would be insolvent and are refused", () => {
  const fee = 1n * SOL;
  assert.equal(settleRoyale(fee * 10n, fee * 8n, 3), null);
});

test("every scenario conserves the cash to the lamport", () => {
  for (const nominal of [0n, 7n, 999n, 12_345_678n, 10n * SOL, 123_456_789_123n]) {
    for (let sab = 0; sab <= 3; sab++) {
      const s = settleRoyale(nominal, nominal, sab)!;
      assert.equal(sumPrizes(s) + s.saboteurTotal + s.rake, nominal);
    }
  }
});

test("VS mode with two players: winner 120% of the net entry, loser 80%, rake retained", () => {
  const entry = 1n * SOL;
  const s = settleVs(entry, ["w", "l"]);
  const net = 900_000_000n;
  assert.equal(s.rake, 200_000_000n);
  assert.equal(sol(s as any, "l"), (net * 80n) / 100n); // 0.72 SOL
  assert.equal(sol(s as any, "w"), (net * 120n) / 100n); // 1.08 SOL
  assert.equal(s.unclaimed, 0n);
  assert.equal(s.swapToGoshi, s.rakeParts.buybackBurn + s.rakeParts.jackpot);
});

test("VS mode from 2 to 9 players conserves the pot and never pays a loser more than 80%", () => {
  for (let n = 2; n <= 9; n++) {
    const entry = 123_456_789n;
    const ranking = Array.from({ length: n }, (_, i) => `p${i}`);
    const s = settleVs(entry, ranking);
    const paid = s.payouts.reduce((a, x) => a + x.lamports, 0n);
    assert.equal(paid + s.rake, entry * BigInt(n));
    const net = entry - (entry * 10n) / 100n;
    for (const p of s.payouts.slice(1)) assert.equal(p.lamports, (net * 80n) / 100n);
    assert.ok(s.payouts[0].lamports >= s.payouts[1].lamports);
  }
  assert.throws(() => settleVs(SOL, ["only"]));
  assert.throws(() => settleVs(SOL, Array.from({ length: 10 }, (_, i) => `p${i}`)));
});
