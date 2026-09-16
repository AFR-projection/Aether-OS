# Aether backend — production image.
#
# Multi-stage: dependencies and the TypeScript build happen in `builder`, and
# only the compiled output plus production dependencies ship in `runtime`.
# node-pty needs python3/make/g++ to compile its native addon during install.

FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@8.15.1 --activate

FROM base AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN pnpm install --frozen-lockfile --filter @aether/backend...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN pnpm --filter @aether/shared build \
 && pnpm --filter @aether/backend build \
 && pnpm deploy --filter @aether/backend --prod /deploy/backend

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production

# Least privilege: the process never runs as root.
RUN groupadd --system --gid 1001 aether \
 && useradd --system --uid 1001 --gid aether --home /opt/aether --create-home aether \
 && mkdir -p /opt/aether/workspace /opt/aether/uploads /opt/aether/static \
 && chown -R aether:aether /opt/aether

WORKDIR /opt/aether/app
COPY --from=builder --chown=aether:aether /deploy/backend ./

USER aether
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
