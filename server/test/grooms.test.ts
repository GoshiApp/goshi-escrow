import test from "node:test";
import assert from "node:assert/strict";
import { GROOM_CODE_ALPHABET, GROOM_MAX_PLAYERS, GROOM_MAX_ROOMS, GROOM_ROSTER_SIZE, GuestRooms, newGuestCode } from "../src/grooms.ts";

/** The manager sends every message through the injected send callback, so tests capture there. */
const setup = () => {
  const out: [any, any][] = [];
  const gr = new GuestRooms((c, m) => out.push([c, m]));
  const client = (ip = "1.1.1.1") => ({
    ws: { readyState: 1, bufferedAmount: 0 }, watching: new Set(), tokens: 60, lastRefill: Date.now(), nonce: "n", ip,
  }) as any;
  const msgs = (c: any, t: string) => out.filter(([x, m]) => x === c && m.t === t).map(([, m]) => m);
  const lastM = (c: any, t: string) => msgs(c, t).at(-1);
  return { gr, client, msgs, lastM };
};

test("newGuestCode makes 4 characters of the unambiguous alphabet", () => {
  assert.equal(newGuestCode(() => 0), "AAAA");
  for (let i = 0; i < 50; i++) {
    const code = newGuestCode();
    assert.equal(code.length, 4);
    for (const ch of code) assert.ok(GROOM_CODE_ALPHABET.includes(ch), `unexpected char ${ch}`);
  }
  assert.ok(!GROOM_CODE_ALPHABET.includes("O") && !GROOM_CODE_ALPHABET.includes("0"));
});

test("create answers groom_created with a valid code and the creator as host", () => {
  const { gr, client, lastM } = setup();
  try {
    const c = client();
    gr.create(c, "Ana");
    const m = lastM(c, "groom_created");
    assert.ok(m, "groom_created sent");
    assert.equal(m.code.length, 4);
    assert.equal(m.max, GROOM_MAX_PLAYERS);
    assert.deepEqual(m.players, [{ n: "Ana", host: true }]);
    assert.equal(c.groom.code, m.code);
    assert.ok(String(c.groom.you).startsWith("you_"));
  } finally {
    gr.stop();
  }
});

test("join answers the joiner with groom_created and tells the room with groom_update", () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    const b = client();
    gr.create(a, "Ana");
    const code = lastM(a, "groom_created").code;
    gr.join(b, "Beto", code);
    const joined = lastM(b, "groom_created");
    assert.equal(joined.code, code);
    assert.deepEqual(joined.players, [{ n: "Ana", host: true }, { n: "Beto", host: false }]);
    assert.deepEqual(lastM(a, "groom_update").players, joined.players);
  } finally {
    gr.stop();
  }
});

test("an unknown code answers no_room; a room already playing still takes newcomers", async () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    gr.join(a, "Ana", "ZZZZ");
    assert.equal(lastM(a, "error").code, "no_room");

    const b = client();
    gr.create(b, "Beto");
    const code = lastM(b, "groom_created").code;
    await gr.start(b);
    const late = client();
    gr.join(late, "Coco", code);
    assert.equal(lastM(late, "groom_created").code, code, "the newcomer is in the room and waits for a body");
  } finally {
    gr.stop();
  }
});

test("a full room refuses the next join with busy", () => {
  const { gr, client, lastM } = setup();
  try {
    const host = client();
    gr.create(host, "Ana");
    const code = lastM(host, "groom_created").code;
    for (let i = 0; i < GROOM_MAX_PLAYERS - 1; i++) gr.join(client(), `P${i}`, code);
    const extra = client();
    gr.join(extra, "Sobrante", code);
    assert.equal(lastM(extra, "error").code, "busy");
  } finally {
    gr.stop();
  }
});

test("the manager refuses to open more than GROOM_MAX_ROOMS rooms", () => {
  const { gr, client, lastM } = setup();
  try {
    for (let i = 0; i < GROOM_MAX_ROOMS; i++) gr.create(client(), `P${i}`);
    assert.equal(gr.size, GROOM_MAX_ROOMS);
    const unlucky = client();
    gr.create(unlucky, "Fuera");
    assert.equal(lastM(unlucky, "error").code, "busy");
  } finally {
    gr.stop();
  }
});

test("start by a non-host is refused; by the host it starts a 10 player match for every member", async () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    const b = client();
    gr.create(a, "Ana");
    const code = lastM(a, "groom_created").code;
    gr.join(b, "Beto", code);
    gr.start(b);
    assert.equal(lastM(b, "error").code, "not_host");

    await gr.start(a);
    for (const cl of [a, b]) {
      const entered = lastM(cl, "entered");
      assert.ok(entered.practice && entered.guest, "entered marked practice+guest");
      const start = lastM(cl, "start");
      assert.ok(start.practice, "start marked practice");
      assert.equal(Object.keys(start.roles).length, GROOM_ROSTER_SIZE, "humans filled up with bots");
    }
    assert.notEqual(lastM(a, "start").you, lastM(b, "start").you);
    const roles = lastM(a, "start").roles;
    assert.equal(roles[lastM(a, "start").you] !== undefined, true);
    assert.equal(roles[lastM(b, "start").you] !== undefined, true);
  } finally {
    gr.stop();
  }
});

test("the host leaving passes the host on; an empty room closes", () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    const b = client();
    gr.create(a, "Ana");
    const code = lastM(a, "groom_created").code;
    gr.join(b, "Beto", code);
    assert.equal(gr.size, 1);
    gr.leave(a);
    assert.deepEqual(lastM(b, "groom_update").players, [{ n: "Beto", host: true }]);
    gr.leave(b);
    assert.equal(gr.size, 0, "empty room closed");
  } finally {
    gr.stop();
  }
});

test("a dropped socket leaves the room; drop during a match clears the membership", async () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    const b = client();
    gr.create(a, "Ana");
    const code = lastM(a, "groom_created").code;
    gr.join(b, "Beto", code);
    gr.drop(b);
    assert.deepEqual(lastM(a, "groom_update").players, [{ n: "Ana", host: true }]);

    await gr.start(a);
    assert.ok(a.groom, "creator still in the room during the match");
    gr.drop(a);
    assert.equal(a.groom, undefined, "drop clears the membership");
  } finally {
    gr.stop();
  }
});

test("input before the match is ignored; input during the match reaches the sim without errors", async () => {
  const { gr, client, msgs } = setup();
  try {
    const a = client();
    gr.create(a, "Ana");
    gr.input(a, 1, 0, false);
    assert.equal(msgs(a, "error").length, 0);
    await gr.start(a);
    gr.input(a, 1, 0, true);
    assert.equal(msgs(a, "error").length, 0);
  } finally {
    gr.stop();
  }
});

test("a socket that joins another room moves, keeping a single membership", async () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    const b = client();
    gr.create(a, "Ana");
    const first = lastM(a, "groom_created").code;
    gr.create(b, "Beto");
    const second = lastM(b, "groom_created").code;
    gr.join(a, "Ana", second);
    assert.equal(a.groom.code, second);
    assert.deepEqual(lastM(b, "groom_update").players, [{ n: "Beto", host: true }, { n: "Ana", host: false }]);
    gr.start(a);
    assert.equal(lastM(a, "error").code, "not_host", "Ana is not the host of the second room");
    await gr.start(b);
    // The first room was left empty and is gone.
    const finder = client();
    gr.join(finder, "Coco", first);
    assert.equal(lastM(finder, "error").code, "no_room");
  } finally {
    gr.stop();
  }
});

test("two guests with the same name both play, with their own ids", async () => {
  const { gr, client, lastM } = setup();
  try {
    const a = client();
    const b = client();
    gr.create(a, "Gemi");
    const code = lastM(a, "groom_created").code;
    gr.join(b, "Gemi", code);
    await gr.start(a);
    const youA = lastM(a, "start").you;
    const youB = lastM(b, "start").you;
    assert.notEqual(youA, youB);
    const names = lastM(a, "start").roles;
    assert.ok(Object.keys(names).length >= 2);
  } finally {
    gr.stop();
  }
});
