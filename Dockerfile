# ---- build stage ----------------------------------------------------------------
FROM node:20-noble-slim AS builder
WORKDIR /build

# Install bun (used by the build scripts and bundler)
RUN npm install -g bun

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ---- runtime stage --------------------------------------------------------------
FROM node:20-noble-slim
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
