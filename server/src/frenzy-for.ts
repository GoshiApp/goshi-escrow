// Shared by the on-chain rooms and the free guest rooms: a frenzy setup with no chain behind it.
import crypto from "node:crypto";
import nacl from "tweetnacl";
import { takeSnapshot } from "./snapshot.js";
import type { FrenzyOptions } from "./match.js";

const sha256 = (...parts: (Uint8Array | string)[]) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The server key signs the price photo. It is loaded only when a frenzy is set up; a copy of the code without the key (the
 *  public repository, the tests) signs with a throwaway key, which simply does not verify. */
let keyP: Promise<Uint8Array> | null = null;
const signingKey = () => (keyP ??= import("./chain.js").then((m) => m.authority.secretKey, () => nacl.sign.keyPair().secretKey));

/** Everything a room needs to be reproducible: the seed from sha256(secret, blockhash, room id), the frozen price photo and
 *  the signature of that photo. The secret was committed to when the room was created and is revealed at settlement. */
export async function frenzyFor(roomId: string, known: Buffer | undefined, blockhash: Uint8Array) {
  const secret = known ?? crypto.randomBytes(32);
  const idBytes = /^\d+$/.test(roomId) ? (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(roomId)); return b; })() : sha256(roomId).subarray(0, 8);
  const seedHash = sha256(secret, blockhash, idBytes);
  const seed = (seedHash.readUInt32LE(0) & 0x7fffffff) || 1;
  const snapshot = await takeSnapshot();
  const commit = sha256(secret).toString("hex");
  const sig = nacl.sign.detached(Buffer.from(`${snapshot.hash}|${commit}|${roomId}`), await signingKey());
  const opts: FrenzyOptions = { snapshot, commit, signature: Buffer.from(sig).toString("hex") };
  return { seed, secret, blockhash, opts, committed: known !== undefined };
}
