// Upgrades the program on mainnet with the new build. The upgrade authority lives in Phantom (Goshi Guardian), so the code can
// only change when that wallet signs. Three steps, each one run on purpose:
//
//   STEP=check  (default) reads the chain and says what will happen, what it costs and whether the payer has enough. Nothing is sent.
//   STEP=buffer the payer key file (the game authority) writes the new code into a buffer account, gives that buffer to the
//               guardian and, when the new code is bigger, makes room in the program. Costs SOL; the buffer deposit comes back
//               to the payer when the upgrade is signed (or when the buffer is closed).
//   STEP=sign   serves a page on this machine where Phantom signs the upgrade itself. Then the script checks that the code
//               on chain is byte for byte the file that was built here.
//
//   RPC_URL=<mainnet rpc> PROGRAM_ID=<program> PAYER_KEYPAIR=../.mainnet-authority.json GUARDIAN=<address> \
//     SO=target/deploy/goshi_escrow_native.so STEP=check npx tsx scripts/program-upgrade.ts
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (!v) throw new Error(`missing ${k}`); return v; };
const conn = new Connection(env("RPC_URL"), "confirmed");
const programId = new PublicKey(env("PROGRAM_ID"));
const payerPath = env("PAYER_KEYPAIR");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, "utf8"))));
const guardian = new PublicKey(env("GUARDIAN"));
const soPath = env("SO", "target/deploy/goshi_escrow_native.so");
const step = env("STEP", "check");
const bufferFile = "target/.upgrade-buffer.json";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER);
const PD_HEADER = 45; // program data account: 4 tag + 8 slot + 1 option + 32 authority, then the code
const BUF_HEADER = 37; // buffer account: 4 tag + 1 option + 32 authority, then the code
const MIN_EXTEND = 10_240;

const code = fs.readFileSync(soPath);
const hash = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const sol = (l: number) => (l / 1e9).toFixed(4);

async function state() {
  const pd = await conn.getAccountInfo(programData);
  if (!pd) throw new Error("program data not found");
  const authority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
  const room = pd.data.length - PD_HEADER;
  // The loader pads the code with zeros up to the room it has: compare only the length of the new file.
  const onChain = pd.data.subarray(PD_HEADER, PD_HEADER + code.length);
  return { authority, room, same: hash(onChain) === hash(code) && pd.data.subarray(PD_HEADER + code.length).every((x) => x === 0) };
}

const s0 = await state();
if (!s0.authority || !s0.authority.equals(guardian)) throw new Error(`the upgrade authority on chain is ${s0.authority?.toBase58() ?? "none"}, not ${guardian.toBase58()}`);
const extend = code.length > s0.room ? Math.max(MIN_EXTEND, code.length - s0.room) : 0;
const bufferRent = await conn.getMinimumBalanceForRentExemption(BUF_HEADER + code.length);
const extendRent = extend ? (await conn.getMinimumBalanceForRentExemption(PD_HEADER + s0.room + extend)) - (await conn.getMinimumBalanceForRentExemption(PD_HEADER + s0.room)) : 0;
const fees = Math.ceil(code.length / 1000) * 5_000 + 50_000;
const need = bufferRent + extendRent + fees;
const have = await conn.getBalance(payer.publicKey);

console.log(`program          ${programId.toBase58()}`);
console.log(`upgrade authority ${guardian.toBase58()} (Phantom: Goshi Guardian)`);
console.log(`new code         ${soPath}  ${code.length} bytes  sha256 ${hash(code)}`);
console.log(`room on chain    ${s0.room} bytes${extend ? `  -> grows by ${extend} (permanent deposit ${sol(extendRent)} SOL)` : ""}`);
console.log(`already deployed ${s0.same ? "YES, nothing to do" : "no"}`);
console.log(`payer            ${payer.publicKey.toBase58()}  has ${sol(have)} SOL, needs about ${sol(need)} SOL (buffer deposit ${sol(bufferRent)} comes back at the upgrade)`);
if (s0.same) process.exit(0);

if (step === "check") {
  console.log(have >= need ? "\nReady for STEP=buffer." : `\nSend at least ${sol(need - have + 10_000_000)} SOL to the payer before STEP=buffer.`);
  process.exit(0);
}

if (step === "buffer") {
  if (have < need) throw new Error(`the payer needs about ${sol(need)} SOL and has ${sol(have)}`);
  if (extend) {
    // ExtendProgram: anybody can pay for more room; it changes nothing in the code.
    const data = Buffer.alloc(8); data.writeUInt32LE(6, 0); data.writeUInt32LE(extend, 4);
    const ix = new TransactionInstruction({ programId: LOADER, data, keys: [
      { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: programId, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ] });
    console.log("extended:", await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]));
  }
  const out = execFileSync("solana", ["program", "write-buffer", soPath, "-k", payerPath, "-u", env("RPC_URL"), "--with-compute-unit-price", "5000"], { encoding: "utf8" });
  const buffer = /Buffer:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(out)?.[1];
  if (!buffer) throw new Error(`write-buffer did not print a buffer: ${out}`);
  execFileSync("solana", ["program", "set-buffer-authority", buffer, "--new-buffer-authority", guardian.toBase58(), "-k", payerPath, "-u", env("RPC_URL")], { encoding: "utf8" });
  fs.writeFileSync(bufferFile, JSON.stringify({ buffer, sha256: hash(code), bytes: code.length }, null, 2));
  console.log(`buffer ${buffer} written and handed to the guardian. Next: STEP=sign`);
  process.exit(0);
}

if (step !== "sign") throw new Error("STEP is check, buffer or sign");
const saved = JSON.parse(fs.readFileSync(bufferFile, "utf8")) as { buffer: string; sha256: string };
if (saved.sha256 !== hash(code)) throw new Error("the buffer was written from another build");
const buffer = new PublicKey(saved.buffer);
const b = await conn.getAccountInfo(buffer);
if (!b) throw new Error("buffer not found");
if (!(b.data[4] === 1 && new PublicKey(b.data.subarray(5, 37)).equals(guardian))) throw new Error("the buffer does not belong to the guardian");
if (hash(b.data.subarray(BUF_HEADER, BUF_HEADER + code.length)) !== hash(code)) throw new Error("the buffer does not hold this build");

/** Upgrade: the guardian (Phantom) signs as upgrade authority, the payer pays the fee and gets the buffer deposit back. */
async function build(): Promise<string> {
  const ix = new TransactionInstruction({ programId: LOADER, data: Buffer.from([3, 0, 0, 0]), keys: [
    { pubkey: programData, isSigner: false, isWritable: true },
    { pubkey: programId, isSigner: false, isWritable: true },
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: guardian, isSigner: true, isWritable: false },
  ] });
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(payer);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const require = createRequire(import.meta.url);
const web3Bundle = fs.readFileSync(require.resolve("@solana/web3.js/lib/index.iife.min.js"), "utf8");
const page = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Actualizar el contrato de Goshi</title>
<style>body{font:16px system-ui;background:#0b1030;color:#eef;max-width:680px;margin:40px auto;padding:0 16px}button{font:inherit;padding:12px 18px;border-radius:12px;border:0;background:#ffd35c;font-weight:800;cursor:pointer}code{color:#ffd35c;word-break:break-all}#log{white-space:pre-wrap;margin-top:16px}li{margin:4px 0}</style>
<h1>Actualizar el contrato de Goshi (v6)</h1>
<p>Programa: <code>${programId.toBase58()}</code></p>
<p>Código nuevo: ${code.length} bytes, huella <code>${hash(code)}</code>. Ya está escrito en la cadena (buffer <code>${buffer.toBase58()}</code>) y pertenece a tu cartera.</p>
<p>Qué cambia:</p>
<ul>
<li>La comisión de la casa baja al 3%: el 95% del pozo va al podio y el 2% a los saboteadores. En VS también 3%.</li>
<li>La mochila para trampas: una reserva opcional al entrar, que vuelve entera si no se gasta. Lo gastado va mitad a mantenimiento y mitad al proyecto, y se paga al juntar 0,05 SOL.</li>
<li>Las salas creadas antes siguen funcionando igual.</li>
</ul>
<p>Abre Phantom con <b>Goshi Guardian</b> seleccionada y pulsa el botón. Phantom te pedirá aprobar una transacción del cargador de programas de Solana (BPF Upgradeable Loader). La comisión de red la paga la clave del juego, no tu cartera.</p>
<button id="go">Conectar Phantom y firmar</button>
<div id="log"></div>
<script src="/web3.js"></script>
<script>
const log = (t) => { document.getElementById("log").textContent += t + "\\n"; };
document.getElementById("go").onclick = async () => {
  try {
    const p = window.phantom && window.phantom.solana;
    if (!p) return log("No encuentro Phantom en este navegador.");
    try { await p.disconnect(); } catch (_) {}
    const r = await p.connect();
    const who = r.publicKey.toString();
    if (who !== "${guardian.toBase58()}") {
      try { await p.disconnect(); } catch (_) {}
      return log("Phantom usa la cuenta " + who + ". Elige Goshi Guardian (${guardian.toBase58()}) arriba a la izquierda en Phantom y vuelve a pulsar.");
    }
    log("Cartera correcta. Preparando la transacción...");
    const b64 = await (await fetch("/tx")).text();
    const tx = solanaWeb3.Transaction.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const signed = await p.signTransaction(tx);
    log("Firmada. Enviando y comprobando el código en la cadena...");
    const res = await fetch("/submit", { method: "POST", body: btoa(String.fromCharCode(...signed.serialize())) });
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
      // Only the one Upgrade instruction of the loader, for this program and this buffer: anything else is refused.
      const ix = tx.instructions[0];
      if (tx.instructions.length !== 1 || !ix.programId.equals(LOADER) || ix.data[0] !== 3 || !ix.keys[1].pubkey.equals(programId) || !ix.keys[2].pubkey.equals(buffer)) throw new Error("unexpected transaction");
      if (!tx.verifySignatures()) throw new Error("a signature is missing or wrong");
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      const after = await state();
      console.log(after.same ? `done: ${sig}` : `sent ${sig} but the code on chain is not this build`);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(after.same
        ? `Hecho. El contrato v6 está en la cadena y su código es exactamente esta compilación.\nTransacción: ${sig}`
        : `Enviada (${sig}) pero el código en la cadena no coincide. Avísame.`);
      if (after.same) fs.rmSync(bufferFile, { force: true });
      setTimeout(() => process.exit(after.same ? 0 : 1), 500);
      return;
    }
    res.writeHead(404).end();
  } catch (e: any) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`Error: ${e?.message ?? e}`);
  }
});
server.listen(8787, "127.0.0.1", () => console.log("open http://localhost:8787 in the browser where Phantom is"));
