# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS build
WORKDIR /app
ENV NODE_USE_ENV_PROXY=1 COREPACK_DEFAULT_TO_LATEST=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/companion/package.json packages/companion/package.json
COPY packages/companion-admin/package.json packages/companion-admin/package.json
COPY packages/compatibility/package.json packages/compatibility/package.json
COPY packages/companion/vendor/mem0ai@3.3.1.patch packages/companion/vendor/mem0ai@3.3.1.patch
RUN --mount=type=secret,id=proxy_ca,required=true \
  corepack enable && \
  export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca && \
  corepack prepare pnpm@11.25.0 --activate && \
  pnpm install --frozen-lockfile
COPY . .
RUN \
  pnpm --filter @oh-bot/companion build && pnpm --filter @oh-bot/companion-admin build

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production NODE_USE_ENV_PROXY=1
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca,required=false \
  set -eu; \
  if [ -s /run/secrets/proxy_ca ]; then \
    apt_ca=/run/secrets/proxy_ca; \
    if [ -s /etc/ssl/certs/ca-certificates.crt ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/companion-ca-bundle.crt; \
      apt_ca=/tmp/companion-ca-bundle.crt; \
    fi; \
    apt-get -o Acquire::https::CaInfo="$apt_ca" update; \
    apt-get -o Acquire::https::CaInfo="$apt_ca" install -y --no-install-recommends postgresql-client-17 restic ca-certificates; \
    rm -f /tmp/companion-ca-bundle.crt; \
  else \
    apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 restic ca-certificates; \
  fi; \
  rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 3010
CMD ["node", "packages/companion/dist/main.js"]

FROM nginx:alpine AS admin
COPY --from=build /app/packages/companion-admin/dist/ /usr/share/nginx/html/
COPY packages/companion/deploy/nginx.conf /etc/nginx/conf.d/default.conf
