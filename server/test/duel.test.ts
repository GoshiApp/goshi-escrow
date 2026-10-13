import { test } from "node:test";
import assert from "node:assert/strict";
import { settleDuel } from "../src/game/settlement.ts";
import { DEFAULT_LIMITS, duelTierAllowed, loadLimits } from "../src/limits.ts";

test("a duel pays the winner everything but 3 percent, and conserves the pot", () => {
  for (let n = 2; n <= 5; n++) {
    const s = settleDuel(123_456_789n, Array.from({ length: n }, (_, i) => `w${i}`));
    assert.equal(s.payouts.length, 1);
    assert.equal(s.payouts[0].lamports + s.rake, 123_456_789n * BigInt(n));
    assert.equal(s.rake, (123_456_789n * BigInt(n) * 3n) / 100n);
  }
  assert.throws(() => settleDuel(1n, ["a"]));
  assert.throws(() => settleDuel(1n, ["a", "b", "c", "d", "e", "f"]));
});

test("limits: soft launch defaults, a partial override merges, a bad one is ignored", () => {
  assert.deepEqual(DEFAULT_LIMITS.sol.duelTiersUsd, [1, 2.5, 5]);
  assert.equal(duelTierAllowed(2.5), true);
  assert.equal(duelTierAllowed(10), false);
  const next = loadLimits(JSON.stringify({ stage: "growth", sol: { duelTiersUsd: [10, 25, 50], maxEntryUsd: 50 } }));
  assert.equal(next.stage, "growth");
  assert.deepEqual(next.sol.duelTiersUsd, [10, 25, 50]);
  assert.equal(next.sol.maxEntryUsd, 50);
  assert.equal(next.sol.duelPlayers[1], 5, "untouched fields keep their defaults");
  assert.equal(loadLimits("{not json").stage, "soft-launch");
});
