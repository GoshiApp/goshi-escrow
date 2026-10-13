// Cosmetic skins. They never change a rule: only how a body is painted. A skin that needs holding the token is checked on the
// server (the wallet that signed in must hold at least `holdMin` of the token), so nobody else sees a skin it did not earn.
// Skins earned by playing are a cosmetic claim kept by the browser; the server only accepts ids it knows.

/** What a holder skin needs, in USD of $GOSHI held (not a token count): the price is read at the time of the check. */
export const SKIN_HOLD_USD: Readonly<Record<string, number>> = {
  "holder-bronze": 20,
  "holder-silver": 200,
  "holder-gold": 1000,
};

export const OPEN_SKINS: readonly string[] = [
  "classic", "mint", "coral", "sky", "stripes", "candy", "neon", "sunset", "galaxy", "gold", "ember", "aurora", "pepe", "shiba", "doge", "bonk", "popcat", "wif",
];

export const isKnownSkin = (id: unknown): id is string =>
  typeof id === "string" && (OPEN_SKINS.includes(id) || id in SKIN_HOLD_USD || FOUNDER_SKINS.includes(id));

/** Skins only for the wallets listed in FOUNDER_WALLETS (comma separated). With the list empty, nobody can wear them. */
export const FOUNDER_SKINS: readonly string[] = ["ceo"];
const FOUNDERS = new Set((process.env.FOUNDER_WALLETS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
export const isFounder = (wallet: string | undefined): boolean => !!wallet && FOUNDERS.has(wallet);
