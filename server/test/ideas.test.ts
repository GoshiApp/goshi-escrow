import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handleIdeas } from "../src/ideas.ts";

const ORIGIN = "https://goshi.app";
const srv = http.createServer((q, r) => { if (!handleIdeas(q, r, [ORIGIN])) r.writeHead(404).end(); });
await new Promise<void>((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${(srv.address() as any).port}`;
const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, j: (await r.json()) as any };
};
const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 1)]).toString("base64");

test("propose, vote, sort, report", async () => {
  const A = "a".repeat(20), B = "b".repeat(20), C = "c".repeat(20), D = "d".repeat(20);
  const one = await call("/ideas", "POST", { voter: A, title: "Laser chess", text: "Two players race to claim the board with lasers.", images: [png] });
  assert.equal(one.code, 200);
  const two = await call("/ideas", "POST", { voter: B, title: "Tower stack", text: "Stack blocks as high as you can before time ends." });
  assert.equal(two.code, 200);
  await call(`/ideas/${two.j.id}/vote`, "POST", { voter: C, v: 1 });
  await call(`/ideas/${one.j.id}/vote`, "POST", { voter: C, v: -1 });
  const top = await call("/ideas?sort=top");
  assert.equal(top.j.items[0].id, two.j.id);
  assert.equal(top.j.items[0].net, 2);
  assert.equal(top.j.items.find((i: any) => i.id === one.j.id).images, 1);
  // changing a vote replaces it, it never adds
  await call(`/ideas/${two.j.id}/vote`, "POST", { voter: C, v: -1 });
  assert.equal((await call("/ideas?sort=top")).j.items.find((i: any) => i.id === two.j.id).net, 0);
  // bad inputs
  assert.equal((await call("/ideas", "POST", { voter: A, title: "x", text: "short" })).code, 400);
  assert.equal((await call("/ideas", "POST", { voter: A, title: "Fake image", text: "An image that is not an image at all.", images: ["data:image/png;base64,AAAA"] })).code, 400);
  // three reports hide it
  for (const v of [A, C, D]) await call(`/ideas/${one.j.id}/report`, "POST", { voter: v });
  assert.equal((await call("/ideas")).j.items.some((i: any) => i.id === one.j.id), false);
  srv.closeAllConnections();
  setTimeout(() => process.exit(0), 100).unref();
  srv.close();
});
