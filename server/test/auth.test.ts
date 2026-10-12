import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { authMessage, verifyAuth } from "../src/auth.ts";

test("wallet auth accepts a real signature and rejects forgeries", () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const nonce = "abc123";
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(authMessage(nonce)), kp.secretKey));
  assert.equal(verifyAuth(wallet, nonce, sig), true);
  assert.equal(verifyAuth(wallet, "other", sig), false);
  const other = nacl.sign.keyPair();
  assert.equal(verifyAuth(bs58.encode(other.publicKey), nonce, sig), false);
  assert.equal(verifyAuth(wallet, nonce, "garbage"), false);
  assert.equal(verifyAuth("short", nonce, sig), false);
});

import { makeSession, verifySession, sessionSecretFrom } from "../src/auth.ts";

test("a session token proves the wallet without a new signature and expires", () => {
  const secret = sessionSecretFrom(new Uint8Array(64).fill(7));
  const { token, expiresAt } = makeSession("WalletA", secret, 1_000, 5_000);
  assert.equal(expiresAt, 6_000);
  assert.equal(verifySession(token, secret, 2_000), "WalletA");
  assert.equal(verifySession(token, secret, 7_000), null, "expired");
  assert.equal(verifySession(token.replace("WalletA", "WalletB"), secret, 2_000), null, "tampered wallet");
  assert.equal(verifySession(token + "x", secret, 2_000), null, "tampered mac");
  assert.equal(verifySession(token, sessionSecretFrom(new Uint8Array(64).fill(8)), 2_000), null, "other server secret");
  assert.equal(verifySession(undefined, secret), null);
  assert.equal(verifySession("a.b", secret), null);
});

import { siwsMessage, siwsAccepted, SIWS_STATEMENT as _S } from "../src/auth.ts";
test("SIWS text: accepted only for this wallet, nonce, a known host and a fresh time", async () => {
  const nacl = (await import("tweetnacl")).default;
  const bs58 = (await import("bs58")).default;
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const nonce = "ab12cd34ab12cd34ab12cd34ab12cd34";
  const msg = siwsMessage({ domain: "goshi.app", address: wallet, uri: "https://goshi.app", chain: "devnet", nonce, issuedAt: new Date().toISOString() });
  const hosts = ["goshi.app"];
  assert.equal(siwsAccepted(msg, wallet, nonce, hosts), true);
  assert.equal(siwsAccepted(msg, wallet, "00" + nonce.slice(2), hosts), false, "other nonce");
  assert.equal(siwsAccepted(msg, bs58.encode(nacl.sign.keyPair().publicKey), nonce, hosts), false, "other wallet");
  assert.equal(siwsAccepted(msg, wallet, nonce, ["evil.example"]), false, "unknown host");
  const old = siwsMessage({ domain: "goshi.app", address: wallet, uri: "https://goshi.app", chain: "devnet", nonce, issuedAt: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(siwsAccepted(old, wallet, nonce, hosts), false, "stale");
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));
  assert.equal(verifyAuth(wallet, nonce, sig, msg, hosts), true);
  assert.equal(verifyAuth(wallet, nonce, sig, msg + "x", hosts), false);
});
