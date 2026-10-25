import test from "node:test";
import assert from "node:assert/strict";
import { practiceAdmit } from "../src/practice-admit.ts";

const caps = { maxPractice: 30, maxPerIp: 6, maxSurvival: 10, maxSurvivalPerIp: 1 };

test("survival matches do not count against the practice pool", () => {
  const counts = { normal: 30, survival: 0, perIp: 0 };
  assert.equal(practiceAdmit("normal", counts, caps), "busy");
  assert.equal(practiceAdmit("survival", counts, caps), null);
});

test("normal matches do not count against the survival pool", () => {
  const counts = { normal: 0, survival: 10, perIp: 0 };
  assert.equal(practiceAdmit("survival", counts, caps), "busy");
  assert.equal(practiceAdmit("normal", counts, caps), null);
});

test("per-IP caps are separate: a second survival from the same IP is refused, a normal one is not", () => {
  const counts = { normal: 0, survival: 0, perIp: 1 };
  assert.equal(practiceAdmit("survival", counts, caps), "busy");
  assert.equal(practiceAdmit("normal", counts, caps), null);
});

test("at the pool limit the mode is refused, below it admitted", () => {
  assert.equal(practiceAdmit("normal", { normal: 29, survival: 0, perIp: 5 }, caps), null);
  assert.equal(practiceAdmit("normal", { normal: 29, survival: 0, perIp: 6 }, caps), "busy");
  assert.equal(practiceAdmit("survival", { normal: 0, survival: 9, perIp: 0 }, caps), null);
  assert.equal(practiceAdmit("survival", { normal: 0, survival: 9, perIp: 1 }, caps), "busy");
});
