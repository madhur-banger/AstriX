FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./

RUN npm ci
COPY . .

RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

RUN npm  ci --omit=dev

COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 8000

CMD ["node", "dist/index.js"]


