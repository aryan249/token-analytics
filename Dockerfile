FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/

RUN npx tsc --outDir dist --skipLibCheck --noEmitOnError false 2>&1 | grep -v "node_modules/" || true; \
    test -f dist/indexer/main.js || (echo "Build failed: dist not produced" && exit 1)

FROM node:20-alpine

RUN addgroup -g 1001 appgroup && adduser -u 1001 -G appgroup -s /bin/sh -D appuser

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

RUN chown -R appuser:appgroup /app

USER appuser

CMD ["node", "dist/indexer/main.js"]
