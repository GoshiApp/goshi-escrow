import test from "node:test";
import assert from "node:assert/strict";
import { LiveArena, LIVE_PLACES } from "../src/live.ts";

const fakeClient = () => {
  const sent: any[] = [];
  const c: any = { ws: { readyState: 1, bufferedAmount: 0, send: (s: string) => sent.push(JSON.parse(s)) }, watching: new Set(), tokens: 60, lastRefill: Date.now(), nonce: "n" };
  return { c, sent };
};

test("the live arena starts full of bots with fixed addresses, and a person takes a place", () => {
  const out: any[] = [];
  const live = new LiveArena((c: any, m: object) => out.push([c, m]));
  try {
    const a = live.botAddresses();
    assert.equal(a.length, LIVE_PLACES);
    assert.equal(new Set(a).size, LIVE_PLACES, "every bot has its own address");
    const again = new LiveArena(() => {});
    assert.deepEqual(again.botAddresses(), a, "the addresses are the same after a restart");
    again.stop();
    assert.ok(!a.includes("2kLcGpwnpz5eroGRW2kWqCdizmPEGDLTb5JAce9u2GJ9"), "there is no bot standing for the CEO");

    const { c } = fakeClient();
    assert.equal(live.watch(c), true);
    assert.equal(live.stats().watching, 1);
    live.join(c, "Ana", null);
    assert.equal(live.stats().humans, 1);
    const mine = out.filter(([x]) => x === c).map(([, m]) => m).filter((m: any) => m.t === "live").pop();
    assert.equal(mine.state, "playing");
    assert.ok(String(mine.you).startsWith("you_"));
    // Leaving frees the place and the bot is back.
    live.leave(c);
    assert.equal(live.stats().humans, 0);
  } finally {
    live.stop();
  }
});

test("when the places are full the next people wait in order and take a place when one is freed", () => {
  const out: any[] = [];
  const live = new LiveArena((c: any, m: object) => out.push([c, m]));
  try {
    const people = Array.from({ length: LIVE_PLACES + 2 }, () => fakeClient().c);
    for (const p of people) live.watch(p);
    for (const p of people) live.join(p, "", null);
    // Every place can hold a person: 20 sit, the rest wait.
    assert.equal(live.stats().humans, LIVE_PLACES);
    assert.equal(live.stats().waiting, 2);
    live.leave(people[0]);
    assert.equal(live.stats().humans, LIVE_PLACES, "the first one waiting took the freed place");
    assert.equal(live.stats().waiting, 1);
  } finally {
    live.stop();
  }
});

test("viewers get every other picture, and the orbs of a skipped one travel with the next; one address can only open two viewers", () => {
  const live = new LiveArena(() => {});
  try {
    const mk = (ip: string) => {
      const got: any[] = [];
      const c: any = { ip, ws: { readyState: 1, bufferedAmount: 0, send: (s: string) => got.push(JSON.parse(s)) }, watching: new Set(), tokens: 60, lastRefill: Date.now(), nonce: "n" };
      return { c, got };
    };
    const a = mk("1.1.1.1"), b = mk("1.1.1.1"), extra = mk("1.1.1.1");
    assert.equal(live.watch(a.c), true);
    assert.equal(live.watch(b.c), true);
    assert.equal(live.watch(extra.c), false, "a third viewer from the same address is refused");
    const base = { t: "snap", roomId: "live-arena", players: [], events: [] };
    const snaps = (live as any);
    a.got.length = 0;
    snaps.frame = 0; snaps.skipped = null;
    snaps.onSnap({ ...base, tick: 1, eatenOrbs: [], newOrbs: [] });
    snaps.onSnap({ ...base, tick: 2, eatenOrbs: [1], newOrbs: [{ id: 9, x: 0, y: 0, v: 1 }] });
    snaps.onSnap({ ...base, tick: 3, eatenOrbs: [9], newOrbs: [{ id: 10, x: 0, y: 0, v: 1 }] });
    const seen = a.got.filter((m) => m.t === "snap");
    assert.deepEqual(seen.map((m) => m.tick), [1, 3], "the viewer skipped the middle picture");
    assert.deepEqual(seen[1].eatenOrbs, [1], "what was eaten in the skipped picture arrives; an orb born and eaten in between never shows");
    assert.deepEqual(seen[1].newOrbs.map((o: any) => o.id), [10]);
  } finally {
    live.stop();
  }
});
