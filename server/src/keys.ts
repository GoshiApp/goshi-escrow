// On mainnet the keys must be three different things: the hot key this server holds (opens and settles rooms), the guardian (cold:
// house wallets, vault, settings, replacing the authority) and the upgrade authority of the program. A server that finds the
// roles collapsed into the key it holds refuses to start, instead of running with all the power in a file on a disk.
import { PublicKey } from "@solana/web3.js";
import { authorityPubkey, onChainRoles, upgradeAuthorityOf } from "./chain.js";
import { config, log } from "./config.js";

export async function assertKeysSeparated(): Promise<void> {
  if (config.cluster !== "mainnet-beta") return;
  if (process.env.ALLOW_SINGLE_KEY === "yes-really") return void log("single_key_allowed");
  const roles = await onChainRoles();
  if (!roles) throw new Error("Refusing to start: the program is not initialized (or its configuration is the old layout: migrate it).");
  if (!roles.authority.equals(authorityPubkey)) throw new Error("Refusing to start: the key this server holds is not the authority of the program.");
  if (roles.guardian.equals(authorityPubkey)) throw new Error("Refusing to start: the guardian is the same key as the game authority. Name a cold key or a multisig as guardian.");
  const up = await upgradeAuthorityOf(new PublicKey(config.programId));
  if (up === undefined) throw new Error("Refusing to start: the upgrade authority of the program could not be read.");
  if (up !== null && up.equals(authorityPubkey)) throw new Error("Refusing to start: the upgrade authority of the program is the key this server holds.");
  log("keys_separated", { guardian: roles.guardian.toBase58().slice(0, 6), upgrade: up ? up.toBase58().slice(0, 6) : "immutable" });
}
