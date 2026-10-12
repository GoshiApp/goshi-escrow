import test from "node:test";
import assert from "node:assert/strict";
import { build, feeAllowed, feeOptions } from "../src/price.ts";

test("entry options are about the wanted dollars, rounded to 0.001 SOL", () => {
  const at150 = build(150);
  assert.deepEqual(at150.map((o) => o.usd), [1, 2.5, 5, 7.5, 10]);
  assert.equal(at150[0].lamports, 7_000_000n); // 0.007 SOL is about 1.05 USD
  assert.equal(at150[1].lamports, 17_000_000n);
  assert.equal(at150[2].lamports, 33_000_000n);
  assert.equal(at150[3].lamports, 50_000_000n);
  const at200 = build(200);
  assert.equal(at200[0].lamports, 5_000_000n);
  for (const o of build(87)) assert.equal(o.lamports % 1_000_000n, 0n);
});

test("a very high price never rounds the entry to zero", () => {
  for (const o of build(50_000)) assert.ok(o.lamports >= 1_000_000n);
});

test("only current entry options are allowed", () => {
  const first = feeOptions()[0].lamports;
  assert.equal(feeAllowed(first), true);
  assert.equal(feeAllowed(123n), false);
});
