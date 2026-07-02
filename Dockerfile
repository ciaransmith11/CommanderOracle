# Portable image for any container host (Fly.io, a VPS, etc.).
# Node 24 → node:sqlite runs without the --experimental-sqlite flag.
FROM node:24-slim

# pnpm via corepack (version comes from the lockfile / packageManager).
RUN corepack enable

WORKDIR /app

# Install deps first for better layer caching, then build.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# The server binds $PORT (default 8787). Saved sessions live at DB_PATH — mount a
# volume and set DB_PATH=/data/commander-oracle.sqlite to persist them.
ENV PORT=8787
EXPOSE 8787

CMD ["pnpm", "start"]
