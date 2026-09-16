# Aether frontend — static build image.
#
# The frontend ships as static files served by the backend (`AETHER_STATIC_DIR`)
# in the default single-container deployment. This image exists for deployments
# that want the UI on its own host or CDN: it builds the bundle and serves it
# with a tiny static server. No secrets are baked in — the API base URL is a
# runtime `VITE_API_URL` build arg with a same-origin default.

FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@8.15.1 --activate

FROM base AS builder
WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
RUN pnpm install --frozen-lockfile --filter @aether/frontend...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/frontend packages/frontend

ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @aether/shared build \
 && pnpm --filter @aether/frontend build

FROM nginx:1.27-alpine AS runtime
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/packages/frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
