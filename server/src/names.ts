/** Names the project keeps for itself, shared by practice, the live arena and the guest rooms. */

/** The one wallet allowed to use the project's name. Public address. */
export const CEO_WALLET = "2kLcGpwnpz5eroGRW2kWqCdizmPEGDLTb5JAce9u2GJ9";

/** True when a name reads as the project's own: goshi with common look-alikes (0 for o, 1 or l or ! for i, $ for s, spaces). */
export function reservedName(name: string): boolean {
  const flat = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[0]/g, "o").replace(/[1l!|]/g, "i").replace(/[$5]/g, "s").replace(/[^a-z]/g, "");
  return flat.includes("goshi");
}
