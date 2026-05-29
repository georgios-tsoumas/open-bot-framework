FROM node:22 AS client-builder

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build


FROM node:22 AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev


FROM node:22-slim AS production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=client-builder /app/client/dist ./client/dist

EXPOSE 1986 1992

CMD ["node", "dist/src/main"]
