# ---- build stage ----------------------------------------------------------------
FROM node:23-slim AS builder
WORKDIR /build

# Build tools needed to compile sqlite3 from source
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install bun (used by the build scripts and bundler)
RUN npm install -g bun

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Recompile sqlite3 against this image's glibc so it works in the runtime stage
RUN npm rebuild sqlite3 --build-from-source

COPY . .
RUN bun run build

# ---- runtime stage --------------------------------------------------------------
FROM node:23-slim
WORKDIR /app

# wget is used by the HEALTHCHECK
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules

ENV HUB_DATA_DIR=/data
EXPOSE 4343

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4343/healthz || exit 1

CMD ["node", "dist/cli.js", "serve"]
