FROM node:24.19.0-bookworm
RUN npm install --global pnpm@11.25.0
WORKDIR /app
