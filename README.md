# Goshi escrow and game server

Open source skill games on Solana. Enter. Play. Win. Leave.

- `native/`: the escrow program (native Solana program, about 57 KB). Rooms in SOL, 88/2/10 split, pass seats, manual vault withdrawal, proof logs.
- `server/`: the real-time game server: the minute of frenzy, the arena, fair seed (commit and reveal), replays, live stats. Protocol in `server/PROTOCOL.md`.

Website and client: [goshi-web](https://github.com/GoshiApp/goshi-web). Licensed under Apache 2.0. The program is not audited by an external firm.
