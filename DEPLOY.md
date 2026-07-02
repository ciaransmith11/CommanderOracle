# Deploying Commander Oracle

The app deploys as **one service**: the Hono server serves both the API (`/api/*`)
and the built React frontend, so everything is same-origin behind a single URL.

## Why not serverless
The backend uses Node's built-in `node:sqlite` (a local file for saved sessions)
and streams responses via SSE with long-running model calls. Both want a
long-lived process, so deploy to an **always-on Node service** (Railway, Render,
Fly.io, or any VPS) — not Vercel/Netlify functions.

## Requirements
- **Node 24** (recommended). `node:sqlite` runs flag-free there. On Node 22.x it
  is behind a flag — set `NODE_OPTIONS=--experimental-sqlite` if you must use 22.
- **`ANTHROPIC_API_KEY`** — required for the model calls (`/api/analyse`, `/api/build`, …).
- A small **persistent disk** (optional but recommended) so saved sessions survive
  redeploys. Without it the SQLite file is ephemeral and resets on each deploy.
- Outbound network access to `api.scryfall.com` and `api.anthropic.com` (default).

## Build & start
The repo root exposes the two commands a host needs:

```sh
pnpm install && pnpm build   # installs deps, builds the frontend → packages/web/dist
pnpm start                   # runs the server (serves API + that dist) on $PORT
```

`pnpm start` runs the server from `packages/server`, which serves `../web/dist`.
The server binds `process.env.PORT` (hosts set this automatically).

## Environment variables

| Variable            | Required | Default                      | Notes |
|---------------------|----------|------------------------------|-------|
| `ANTHROPIC_API_KEY` | yes      | —                            | Your Anthropic key. |
| `PORT`              | no       | 8787                         | Set automatically by most hosts. |
| `DB_PATH`           | no       | `./commander-oracle.sqlite`  | Point at a mounted disk, e.g. `/data/commander-oracle.sqlite`. |
| `ANTHROPIC_MODEL`   | no       | `claude-sonnet-4-6`          | Override the model. |
| `ANTHROPIC_MAX_TOKENS` | no    | `8192`                       | |
| `WEB_DIST`          | no       | `../web/dist`                | Only if you run the server from a non-standard cwd. |

---

## Railway (simplest)
1. **railway.app → New Project → Deploy from GitHub repo** → pick `CommanderOracle`.
2. Railway auto-detects pnpm and the root `build`/`start` scripts. If you need to
   set them explicitly: Build = `pnpm install && pnpm build`, Start = `pnpm start`.
3. **Variables** tab → add `ANTHROPIC_API_KEY`. (PORT is injected automatically.)
4. **Add a Volume** (persistent disk) mounted at `/data`, then add
   `DB_PATH=/data/commander-oracle.sqlite`.
5. Ensure Node 24: add a variable `NODE_VERSION=24` (Nixpacks) — the root
   `engines` field also requests `>=22.5`.
6. **Settings → Networking → Generate Domain** → your public URL.

## Render (alternative)
1. **render.com → New → Web Service** → connect the repo.
2. **Runtime:** Node. **Build Command:** `pnpm install && pnpm build`.
   **Start Command:** `pnpm start`.
3. **Environment:** add `ANTHROPIC_API_KEY`. Set Node version by committing a
   `.node-version` file containing `24` (or an env var `NODE_VERSION=24`).
4. **Disks:** add a disk mounted at `/data`, then set `DB_PATH=/data/commander-oracle.sqlite`.
5. Deploy → Render gives you an `onrender.com` URL.

---

## Verifying a deploy
- `GET /api/health` → `{"ok":true,"hasApiKey":true,...}` (confirms the key is set).
- Open the URL → the app loads; try a Build to exercise Scryfall + the model.

## Notes
- The frontend calls the API with **relative** `/api/*` paths, so no frontend
  rebuild or base-URL config is needed as long as it's served from this server.
- If you ever split frontend/backend onto different origins, you'd need to add an
  API base URL to `packages/web/src/api.ts` and rely on the server's CORS (already
  enabled on `/api/*`).
