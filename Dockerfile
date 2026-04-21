FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY data ./data

RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
