import test from "node:test";
import assert from "node:assert/strict";

test("rooms are split between regions by their id: each server creates and runs only its own", async () => {
  process.env.REGION_COUNT = "2";
  for (const slot of [0, 1]) {
    process.env.REGION_SLOT = String(slot);
    const mod = await import(`../src/config.ts?slot=${slot}`);
    for (let i = 0; i < 200; i++) {
      const id = mod.newOwnedRoomId();
      assert.equal(Number(id % 2n), slot, "a new room belongs to the server that made it");
      assert.equal(mod.ownsRoom(id), true);
      assert.equal(mod.ownsRoom(id + 1n), false, "the neighbour id belongs to the other region");
      assert.ok(id > BigInt(Date.now() - 5000) * 1000n, "the id still starts with the time");
    }
  }
});
