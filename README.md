# Commander Oracle

An MTG Commander (EDH) deck-building advisor. Paste a 99-card decklist or name a
commander and get a categorised echo plus a full strategic audit.

## Architecture

The core principle: **let code do the counting and the data; let the model do the
thinking.** Parsing, categorising, and counting are deterministic and never touch
the model. Card data comes from Scryfall over direct HTTP — never from model recall.

```
packages/
  shared/   Types shared across every layer (the data contract).
  core/     Pure deterministic layer — parse / categorise / count. No I/O, no model.
  server/   Hono backend. Scryfall client, SQLite sessions, and the ONLY model calls.
  web/      React + Vite chat UI.
```

Request flow for an analysis:

```
paste text → parseDecklist (core) → resolveEntries (Scryfall) → categorise (core)
           → deterministic echo  → analyseDeck (model, streamed) → strategic audit
```

The `core` package depends only on `shared`, so it physically cannot call Scryfall
or the model — the split is enforced by the dependency graph, not convention.

## Setup

Requires Node 22+ (uses the built-in `node:sqlite`) and pnpm.

```sh
pnpm install
cp packages/server/.env.example packages/server/.env   # add your ANTHROPIC_API_KEY
```

## Run

Start the backend and frontend together:

```sh
pnpm dev
```

- Frontend: http://localhost:5173
- Backend:  http://localhost:8787

Or run them separately:

```sh
pnpm --filter @commander-oracle/server dev
pnpm --filter @commander-oracle/web dev
```

## Test

```sh
pnpm test          # core unit tests (parser + categoriser) — offline, deterministic
pnpm typecheck     # all packages
pnpm --filter @commander-oracle/server verify:scryfall    # live Scryfall check
pnpm --filter @commander-oracle/server verify:reasoning   # live model reasoning regression
```

`verify:reasoning` replays known card-evaluation cases (deck + commander + question)
through the real model path and checks the response gets the sequence-of-play and
role categorisation right — a guard against doctrine-prompt regressions. It makes
live model + Scryfall calls and needs `ANTHROPIC_API_KEY`. Add a case to
`packages/server/scripts/regression-reasoning.ts` whenever a misread is found and fixed.

## Environment (`packages/server/.env`)

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for `/api/analyse` and `/api/build`. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model for analysis. |
| `ANTHROPIC_MAX_TOKENS` | `4096` | Max output tokens. |
| `PORT` | `8787` | Backend port. |
| `DB_PATH` | `./commander-oracle.sqlite` | SQLite session store. |
