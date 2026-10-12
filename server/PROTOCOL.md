# Goshi play server: WebSocket protocol v2 (SOL rooms, saboteurs, battle royale)

Server: Node.js + TypeScript + `ws`. JSON text frames. Lamports and token base units are strings (u64).
Wallets are base58 public keys. Replaces v1 (token entry fees, Orb Rush circles, boosts).

## Auth
The wallet signs the login message ONCE. The server answers `authed` with `session` (a token valid `sessionTtlMs`, 12 h) and `expiresAt`; the web keeps it
in localStorage per wallet and reconnects (page change, reload, dropped connection) with `{ "t": "auth", "token": "<session>" }` and no wallet popup.
A token only proves the same wallet that signed; it is not a spending authority (every transaction still goes through the wallet).

1. server -> `{ "t": "hello", "nonce", "authMessage", "cluster", "programId", "mint", "devBots": bool, "feePresets": ["<lamports>", ...], "feeOptions": [ { "lamports", "usd" } ], "solUsd": number, "minHolder": "<$GOSHI base units>", "rules": { "matchMs": 300000, "shrinkStartMs": 120000, "tickRate": 20, "paidSlots": 10, "freeSlots": 3 } }`
2. client -> `{ "t": "auth", "wallet", "signature": "<base58 signature of authMessage>" }`
3. server -> `{ "t": "authed", "wallet" }` or `{ "t": "error", "code": "auth_failed" }` and closes.
`{ "t": "ping" }` -> `{ "t": "pong" }`. Idle sockets close after 60 s.

## Entry fees in dollars, and quick match
Entry options are offered in dollars (default 1, 2 and 5 USD, `FEE_USD`) and converted to SOL at the current price (CoinGecko, refreshed every 5 minutes, `SOL_USD` fixes it),
rounded to 0.001 SOL. `hello.feeOptions` lists `{ lamports, usd }`. `{ "t": "quick", "entryFee": "<lamports>" }` (after auth) answers
`{ "t": "quickRoom", "roomId", "created": bool, "paid": n }`: the fullest waiting royale room with that fee and a free paid seat that does not contain the wallet,
or a newly opened one. The client then takes the seat with `join_room` as usual.

## Free practice (no wallet, no money)
At any time, even before `auth`: `{ "t": "practice", "name": "Ana" }`. The server starts an instant match for that socket only: the player plus 12 bots
(9 paid-style and 3 saboteur-style), 3 minutes, the zone starts shrinking at 60 s, same physics and same messages (`entered`, `start`, `snap`, `end`)
with `"practice": true` on `entered`, `start` and `end`. `end.tx` is null and `end.payout.podium` is empty. `input` and `leave` apply to the practice match.
Nothing touches the chain. Limit: 30 practice matches at once (`busy`).

## Rooms (on-chain account `MatchRoom`, program v2)
A room has an entry fee in lamports, up to 10 PAID seats (the player sends the fee with `join_room`) and up to 3 SABOTEUR seats
(`join_free`, no fee, the wallet must hold at least `minHolder` $GOSHI, tokens are not taken). A royale starts when the 10 paid
seats are full. Saboteurs can only join while the room is waiting. Fallback: if a room waits 5 minutes without 10 paid players
and has 2 to 9 paid players, the server offers VS mode to the paid players in it; when every paid player accepts, the server
calls `start_vs` and the match is a VS match (no saboteurs, same arena rules).

## Client -> server
- `{ "t": "createRoom", "entryFee": "<lamports>" }` the server (authority) opens the room. Fee must be one of `feePresets`.
  Answer `{ "t": "roomCreated", "roomId", "tx" }`. Limits: 3 rooms per wallet per hour, 20 open rooms.
- `{ "t": "fillWithBots", "roomId", "paid": 9, "free": 3 }` DEVNET TEST MODE ONLY (`devBots`): the server's own funded test wallets
  join on-chain (paid and saboteur seats) so one person can run a whole match. Answer `{ "t": "botsJoining", "roomId", "paid", "free" }`.
- `{ "t": "faucet" }` DEVNET ONLY: sends 1 devnet SOL and mints enough $GOSHI to hold the saboteur minimum, once per 10 minutes.
  Answer `{ "t": "faucet", "sol": "<lamports>", "goshi": "<base units>", "tx" }`.
- `{ "t": "watch", "roomId" }` lobby updates and the live match as a spectator.
- `{ "t": "enter", "roomId" }` after joining ON-CHAIN (paid or saboteur): attaches the socket to the match. Answer `{ "t": "entered", "roomId", "role": "paid" | "saboteur" }` or `not_in_room`.
- `{ "t": "vs", "roomId", "accept": true }` answers a VS offer.
- `{ "t": "input", "dx": -1..1, "dy": -1..1, "boost": false }` at most 20 per second (the heading steers toward (dx, dy)).
- `{ "t": "leave", "roomId" }`.

## Server -> client
- `{ "t": "lobby", "roomId", "state": "waiting" | "active", "mode": "royale" | "vs", "entryFee", "paid": [wallets], "free": [wallets], "waitedMs" }`
- `{ "t": "vsOffer", "roomId", "paid": n, "expiresInMs": 60000 }` and `{ "t": "vsStarted", "roomId" }` / `{ "t": "vsDeclined", "roomId" }`.
- `{ "t": "start", "roomId", "mode", "startsAt": <ms epoch>, "matchMs", "shrinkStartMs", "world": { "w": 3000, "h": 3000 }, "zone": { "cx", "cy", "r0", "rMin" }, "orbs": [ { "id", "x", "y", "v" } ], "you": "<wallet>", "roles": { "<wallet>": "paid" | "saboteur" } }`
- `{ "t": "snap", "roomId", "tick", "timeLeftMs", "zone": { "cx", "cy", "r" }, "players": [ { "w", "n", "role", "bot": bool, "alive": bool, "prot": bool (spawn protection, cannot die), "h": heading in radians, "m": mass, "r": body radius, "head": [x, y], "body": [[x, y], ...] } ], "eatenOrbs": [ids], "newOrbs": [ { "id", "x", "y", "v" } ], "events": [ { "k": "death", "w", "by": wallet | "zone" | "wall", "rank": n } ] }` at 20 Hz.
- `{ "t": "end", "roomId", "mode", "ranking": [ { "w", "rank", "score", "role" } ], "payout": { "pot", "rake", "podium": [ { "w", "rank", "kind": "sol" | "goshi", "lamports" } ], "unclaimed", "jackpot": { "triggered": bool, "amount": "<$GOSHI base units>", "winner": wallet | null } }, "tx": "<finalize signature>" | null, "error": null | "<plain text>" }`
- `{ "t": "error", "code", "message" }` codes include `paused`, `bad_fee`, `rate_limited`, `not_in_room`, `faucet_*`.

## Game rules (battle royale, solid bodies)
World 3000 x 3000, tick 20 Hz, match 300000 ms. The safe zone is a circle of radius 1450 centered on the arena until 120000 ms. From then it moves in FIVE phases to
radii 1050, 720, 460, 290, 150. Every next circle is random (picked from the match seed) and lies completely inside the previous one, so the middle of the arena
is NOT safe at the end. Each phase lasts one fifth of the remaining time and has three states: `warn` (the next circle is announced, 20% of the phase),
`shrink` (the zone moves to it, 35%), `hold` (it stays). The first circle is announced 5 s before 120000 ms.
`snap.zone` is `{ cx, cy, r, phase: 0..5, state: "calm" | "warn" | "shrink" | "hold", inMs: ms until the state changes (0 at the very end), target?: { cx, cy, r } }`
(`target` while `warn` or `shrink`). Every player has `zout: true` while its head is outside the circle.
Outside the zone a player loses `(mass * 0.10 + 3) * (1 + 0.3 * (phase - 1))` mass per second and dies under 5 (`by: "zone"`).
* Each player is a head plus a SOLID body that follows the head's exact path. Body length grows with mass (one segment per 3 mass, 6 to 150),
  body radius = 10 + 1.1 * sqrt(mass) (about 15 at the start). Start mass 20. Speed = 135 / (1 + mass / 300) units per second, turn rate 270 degrees per second,
  boost x1.7 speed costing 1.5% mass per second (never below 12).
* Nobody can die during the first 8 seconds (spawn protection, `prot`).
* A head that touches the BODY of any other player dies at once. Head against head: the lighter dies, equal masses both die. A player's own body is harmless.
* On death 100% of the mass becomes orbs spread over the exact positions of the body path (value in mass units, at most 80 orbs, equal total).
* Orbs give their value as mass. 600 map orbs are kept topped up.
* The world edge kills.
* Ranking: players alive at the end by mass (heavier first), then dead players by time of death (later is better). Ties: lower wallet.
* Podium = Top 3 of the ranking. Saboteurs who finish on the podium take the capped $GOSHI payout, the rest of their slot goes to the unclaimed pool (contract rules).
* Jackpot: after a full royale of 10 paid players the server rolls a 1% event (crypto random, logged); if it triggers, the whole accumulated jackpot in
  $GOSHI is paid to the 1st place (a paid player, or if a saboteur is first, to the best ranked paid player) with `pay_jackpot`.

## Settlement
Royale: `finalize_royale(podium)` with remaining accounts per podium slot (paid wallet, or the saboteur's FreeCredit PDA).
VS: `finalize_vs(ranking)` with every paid wallet in rank order. A match that cannot be settled in 15 minutes is refunded with `cancel_room`.
After a swap phase is enabled the operator calls `wrap_vault`, `sync_native` and `process_pending_vault`; saboteurs claim with `claim_free_credit`
(the server calls it for them after a batch is processed).


## The minute of frenzy (v3)

Every match, in practice and in rooms, opens with a 60 second individual phase before the arena. Everybody plays the SAME map
(same seed, same price photo), alone, and the mass collected goes into the arena (held between 20 and 90).

`start` carries `startsAt` = start of the ARENA and a `frenzy` object:
`{ startsAt, ms: 60000, tickRate: 20, start: {x,y,m}, carryCap, map, snapshot, commit, signature }`.
`map = { w, h, gems: [[id,x,y,symbol,mass,btc]], walls: [[x,y,w,h]], lasers: [[x,y,w,h,offset]], laserPeriod, laserOn, btcRespawnMs }`.
A laser burns while `(tick + offset) % laserPeriod < laserOn`; touching it costs 25% of the mass, stuns for 1 second and leaves you where
you were. Symbols: 0 SOL, 1 DOGE, 2 AVAX (tier 1, +1 to +2), 3 ETH, 4 BNB (tier 2, +3 to +5), 5 BTC (tier 3, +5 to +8, inside a closed
room with one timed door, back 15 seconds after it is eaten).

Mass of a gem: `base * clamp((price / price_SOL)^0.35, 1, 8)`, held inside its tier range, computed once per room from the frozen photo.
With real prices ETH, BNB and BTC reach the top of their tier, so the price mostly matters for what a gem is worth when SOL moves.

Server to one client (20 Hz): `{ t: "fsnap", roomId, tick, timeLeftMs, you: {x,y,m,stun,h}, taken: [ids], back: [ids], hit, top: [[name,mass]x5], rank }`
and once at the end of the minute `{ t: "fend", roomId, mass, carried, eaten, replay }`.
Client to server: the usual `input` (direction and boost). A player stands still until its first non zero input.

Determinism: fixed step 20 Hz, the direction is quantized to one byte (256 headings) and the engine uses a rounded sine table, so
`simulate(map, entries)` gives the same final state anywhere. Replay file: `GR\x01 | seed u32 | snapshot hash prefix 8 | n u16 | n x (tick u16, angle u8, flags u8)`
with flags bit 0 = nitro, bit 1 = standing. A minute is usually under 1 KB. `GET /replay/<roomId>/<wallet>` returns the bytes of the last 60 matches.

Fair seed: when a room is created the server logs `sha256(secret)` in the `create_room` transaction. At the start the seed is
`sha256(secret | blockhash | room id)` (first 4 bytes). At settlement the program logs `proof = secret | blockhash | price snapshot hash | replay root`
(`Program data` of the closing transaction, nothing stored). `end.proof` carries the same values and the snapshot signature.
Prices come from CoinGecko, then Binance (Pyth Hermes now needs an API key); `snapshot.source` says which one, or `fallback`.

Landing page: `{ t: "stats", on: true }` (no wallet) subscribes to `{ t: "stats", online, playing, matches, volume, prices, solUsd }` every 2 s.
Totals are since the server started and are not persisted yet.
