// Hands the UPGRADE AUTHORITY of the program (who can replace its code) to a wallet that lives in Phantom. The loader instruction
// SetAuthorityChecked asks for two signatures: the current authority (the key file on this machine) and the new one (the wallet in
// the browser), so a typo in the new address can never lock the program. This script
// builds the transaction, signs it with the current key, and serves a page on this machine where Phantom adds the second signature.
// The signed transaction comes back here and is sent; nothing secret ever leaves this machine.
//
//   RPC_URL=<mainnet rpc> PROGRAM_ID=<program> GUARDIAN_KEYPAIR=../.mainnet-guardian.json NEW_GUARDIAN=<address> \
//     npx tsx scripts/upgrade-authority-handover.ts         then open http://localhost:8787 in the browser where Phantom is
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const conn = new Connection(env("RPC_URL"), "confirmed");
const programId = new PublicKey(env("PROGRAM_ID"));
const current = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(env("GUARDIAN_KEYPAIR"), "utf8"))));
const next = new PublicKey(env("NEW_GUARDIAN"));
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER);
const require = createRequire(import.meta.url);
const web3Bundle = fs.readFileSync(require.resolve("@solana/web3.js/lib/index.iife.min.js"), "utf8");

/** The upgrade authority stored in the program data account (None when the program was made immutable). */
async function upgradeAuthority(): Promise<PublicKey | null> {
  const a = await conn.getAccountInfo(programData);
  if (!a) throw new Error("program data not found");
  return a.data[12] === 1 ? new PublicKey(a.data.subarray(13, 45)) : null;
}

const now0 = await upgradeAuthority();
if (!now0 || !now0.equals(current.publicKey)) throw new Error(`the key file is not the upgrade authority (on chain: ${now0?.toBase58() ?? "none"})`);
if (now0.equals(next)) { console.log("the new address is already the upgrade authority, nothing to do"); process.exit(0); }
console.log(`current upgrade authority ${current.publicKey.toBase58()}  ->  new ${next.toBase58()}`);

const setAuthorityChecked = () => new TransactionInstruction({
  programId: LOADER,
  keys: [
    { pubkey: programData, isSigner: false, isWritable: true },
    { pubkey: current.publicKey, isSigner: true, isWritable: false },
    { pubkey: next, isSigner: true, isWritable: false },
  ],
  data: Buffer.from([7, 0, 0, 0]),
});

/** A fresh transaction (a blockhash lives about a minute): the current guardian pays and signs, the new one signs in Phantom. */
async function build(): Promise<string> {
  const tx = new Transaction().add(setAuthorityChecked());
  tx.feePayer = current.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(current);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const page = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Traspaso de la autoridad de actualización</title>
<style>body{font:16px system-ui;background:#0b1030;color:#eef;max-width:640px;margin:40px auto;padding:0 16px}button{font:inherit;padding:12px 18px;border-radius:12px;border:0;background:#ffd35c;font-weight:800;cursor:pointer}code{color:#ffd35c;word-break:break-all}#log{white-space:pre-wrap;margin-top:16px}</style>
<h1>Traspaso de la autoridad de actualización del programa de Goshi</h1>
<p>Autoridad actual (archivo de este Mac): <code>${current.publicKey.toBase58()}</code></p>
<p>Nueva autoridad (tu Phantom): <code>${next.toBase58()}</code></p>
<p>Abre Phantom con la cartera <b>Goshi Guardian</b> seleccionada y pulsa el botón. Phantom te pedirá aprobar una transacción del cargador de programas de Solana (BPF Upgradeable Loader).</p>
<button id="go">Conectar Phantom y firmar</button>
<div id="log"></div>
<script src="/web3.js"></script>
<script>
const log = (t) => { document.getElementById("log").textContent += t + "\\n"; };
document.getElementById("go").onclick = async () => {
  try {
    const p = window.phantom && window.phantom.solana;
    if (!p) return log("No encuentro Phantom en este navegador.");
    // Forget the earlier connection of this page, so Phantom asks again with the account that is selected now.
    try { await p.disconnect(); } catch (_) {}
    const r = await p.connect();
    const who = r.publicKey.toString();
    if (who !== "${next.toBase58()}") {
      try { await p.disconnect(); } catch (_) {}
      return log("Phantom usa la cuenta " + who + ". Abre Phantom, toca el nombre de la cuenta arriba a la izquierda, elige Goshi Guardian (${next.toBase58()}) y vuelve a pulsar el botón.");
    }
    log("Conectada la cartera correcta. Preparando la transacción...");
    const b64 = await (await fetch("/tx")).text();
    const tx = solanaWeb3.Transaction.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const signed = await p.signTransaction(tx);
    const out = btoa(String.fromCharCode(...signed.serialize()));
    log("Firmada. Enviando...");
    const res = await fetch("/submit", { method: "POST", body: out });
    log(await res.text());
  } catch (e) { log("Error: " + (e && e.message ? e.message : e)); }
};
</script></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    if (req.url === "/web3.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(web3Bundle);
    if (req.url === "/tx") return void res.writeHead(200, { "content-type": "text/plain" }).end(await build());
    if (req.url === "/submit" && req.method === "POST") {
      const parts: Buffer[] = [];
      for await (const ch of req) parts.push(ch as Buffer);
      const tx = Transaction.from(Buffer.from(Buffer.concat(parts).toString(), "base64"));
      // Only this one instruction, to this program, signed by both guardians: anything else is refused.
      if (tx.instructions.length !== 1 || !tx.instructions[0].programId.equals(LOADER) || tx.instructions[0].data[0] !== 7 || !tx.instructions[0].keys[0].pubkey.equals(programData)) throw new Error("unexpected transaction");
      if (!tx.verifySignatures()) throw new Error("a signature is missing or wrong");
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      const ok = (await upgradeAuthority())?.equals(next) === true;
      console.log(ok ? `done: ${sig}` : `sent ${sig} but the upgrade authority did not change`);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(ok ? `Hecho. La nueva autoridad de actualización es ${next.toBase58()}.\nTransacción: ${sig}` : `Enviada (${sig}) pero la autoridad no cambió.`);
      setTimeout(() => process.exit(ok ? 0 : 1), 500);
      return;
    }
    res.writeHead(404).end();
  } catch (e: any) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`Error: ${e?.message ?? e}`);
  }
});
server.listen(8787, "127.0.0.1", () => console.log("open http://localhost:8787 in the browser where Phantom is"));
