# BeerPassport admin API image (Express + Prisma, PostgreSQL).
#
# SECURITY — read before editing:
#   * NEVER copy .env, .env.*, or any credential into this image, in any
#     stage. In November 2026, server images with a baked .env layer were
#     public on Docker Hub and leaked the production Firebase key,
#     DATABASE_URL, and other credentials; every one of those secrets had to
#     be rotated. Anything copied into a layer is recoverable by anyone who
#     can pull the image, even if a later layer deletes it.
#   * server/.dockerignore excludes .env* as a backstop; the COPY instructions
#     below are deliberately narrow so secrets cannot ride along by accident.
#   * Runtime configuration arrives only via `docker run --env-file` on the
#     Lightsail box (see scripts/deploy-api.sh). Nothing secret is in this
#     file, in the image, or in the build logs.
#   * Images built from this Dockerfile are pushed to a Docker Hub
#     repository and deployed by immutable digest, never by tag alone.
#
# Build context is server/ (see docs/ci-cd/workflows/api-image.yml).

# ---------------------------------------------------------------------------
# deps: full dependency install + Prisma client generation.
# The openssl package is required so Prisma 4.x can detect the distro's
# OpenSSL 3 at generate time and pick the matching query engine
# (debian-openssl-3.0.x) for this base image.
# ---------------------------------------------------------------------------
FROM node:26-trixie-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

# ---------------------------------------------------------------------------
# build: TypeScript compile (tsc -> dist/). Test files are excluded by
# tsconfig, scripts/ are not part of the shipped server.
# ---------------------------------------------------------------------------
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: production-only node_modules. The prisma CLI is a devDependency
# and is intentionally absent here, so the generated client is copied in from
# the deps stage: @prisma/client resolves it from node_modules/.prisma/client,
# which also carries the platform query engine binary the API needs at
# runtime. The schema is copied for reference; the generated client embeds
# what it needs.
# ---------------------------------------------------------------------------
FROM node:26-trixie-slim AS prod-deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# ---------------------------------------------------------------------------
# runtime: the shipped image.
# ---------------------------------------------------------------------------
FROM node:26-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/prisma ./prisma
COPY --from=build /app/dist ./dist

# Run as the unprivileged user that ships with the Node image.
USER node

EXPOSE 4100

# Node 26 has a global fetch; no curl/wget is installed in this image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/admin-api/v1/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "dist/index.js"]
