# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca,required=false \
  corepack enable && \
  if [ -s /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca pnpm install --frozen-lockfile; else pnpm install --frozen-lockfile; fi && \
  pnpm --filter @oh-bot/companion build && pnpm --filter @oh-bot/companion-admin build

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca,required=false \
  set -eu; \
  if [ -s /run/secrets/proxy_ca ]; then \
    cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/companion-ca-bundle.crt; \
    apt-get -o Acquire::https::CaInfo=/tmp/companion-ca-bundle.crt update; \
    apt-get -o Acquire::https::CaInfo=/tmp/companion-ca-bundle.crt install -y --no-install-recommends postgresql-client-17 restic ca-certificates; \
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
