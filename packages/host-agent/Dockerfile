# Aether host agent — image for running the agent as a container.
#
# The agent is normally installed on the host it manages (via install.sh), but
# a container image is useful for managing the container host's sibling
# services in lab setups. The workspace is a volume; credentials arrive only
# through the environment, never baked into the image.

FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@8.15.1 --activate

FROM base AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/host-agent/package.json packages/host-agent/
RUN pnpm install --frozen-lockfile --filter @aether/host-agent...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/host-agent packages/host-agent
RUN pnpm --filter @aether/shared build \
 && pnpm --filter @aether/host-agent build \
 && pnpm deploy --filter @aether/host-agent --prod /deploy/agent

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production

RUN groupadd --system --gid 1001 aether \
 && useradd --system --uid 1001 --gid aether --home /opt/aether --create-home aether \
 && mkdir -p /opt/aether/workspace \
 && chown -R aether:aether /opt/aether

WORKDIR /opt/aether/app
COPY --chown=aether:aether --from=builder /deploy/agent ./

USER aether
VOLUME ["/opt/aether/workspace"]

CMD ["node", "dist/index.js"]
