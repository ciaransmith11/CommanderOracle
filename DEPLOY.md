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

The repo ships host config so most of this is automatic:
- **`railway.json`** — build/start commands for Railway.
- **`render.yaml`** — a Render Blueprint (service, env, disk, health check).
- **`Dockerfile`** + **`.dockerignore`** — a portable image for Fly.io / any container host.

## Railway (simplest)
1. **railway.app → New Project → Deploy from GitHub repo** → pick `CommanderOracle`.
   Railway reads `railway.json` for the build/start commands.
2. **Variables** tab → add `ANTHROPIC_API_KEY` and `NODE_VERSION=24`. (PORT is injected automatically.)
3. **Add a Volume** (persistent disk) mounted at `/data`, then add
   `DB_PATH=/data/commander-oracle.sqlite`.
4. **Settings → Networking → Generate Domain** → your public URL.

## Render (alternative)
1. **render.com → New → Blueprint** → point at the repo. Render reads `render.yaml`
   (service, Node 24, `/data` disk, `DB_PATH`, `/api/health` check).
2. Fill in the `ANTHROPIC_API_KEY` secret when prompted (it's `sync: false`).
3. Deploy → Render gives you an `onrender.com` URL.
   - On the **free** plan, remove the `disk:` block from `render.yaml` first (free has
     no persistent disk; saved sessions won't survive redeploys).

## Docker / Fly.io / VPS
```sh
docker build -t commander-oracle .
docker run -p 8787:8787 -e ANTHROPIC_API_KEY=sk-... \
  -v commander-data:/data -e DB_PATH=/data/commander-oracle.sqlite \
  commander-oracle
```
For Fly.io: `fly launch` (it detects the Dockerfile), set the secret with
`fly secrets set ANTHROPIC_API_KEY=...`, and add a volume mounted at `/data`.

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
