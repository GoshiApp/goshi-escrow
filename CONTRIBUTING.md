# Contributing to Goshi

Goshi is open source (Apache 2.0) and built with the community. Everybody can propose and help: games, improvements, fixes, docs and translations.

## Ways to take part
- **Propose a game or a feature:** open an issue with the "Game proposal" or "Improvement" template, or start a thread in Discussions. Say what the player does, how skill decides the result, and what it needs from the server.
- **Report a bug:** use the "Bug" template with steps to reproduce.
- **Send code:** fork, branch, make one logical change, run the checks, open a pull request.
- **Security issues:** do NOT open a public issue. Read SECURITY.md.

## How a proposal becomes part of Goshi
1. Idea in an issue or a discussion.
2. Short written proposal (the template asks the right questions).
3. Maintainers (Goshi Labs) answer: accepted, needs changes, or not now, with the reason.
4. Implementation by you or by anybody else, in a pull request.
5. Review, tests and, for anything that touches money, an extra review. Games that handle real funds are only enabled after that review.

## Rules of the road
- Games must be **skill based**. No random prizes, no paid re-rolls, no earnings promises in any text.
- The server is the only authority on the result. Clients never decide who wins.
- No keys, secrets or personal data in the repository, ever.
- One logical change per pull request. Tests for what you change.
- Be kind: see CODE_OF_CONDUCT.md.

## Running the project
```
cd native && cargo build-sbf        # the program
cd native && npm install && npm test # integration tests on a local validator
cd server && npm install && npm test # server unit tests
cd server && DEV_BOTS=1 npm run dev   # local game server (devnet)
```
See server/PROTOCOL.md for the wire protocol.

## License
By contributing you agree that your contribution is licensed under the Apache License 2.0.
