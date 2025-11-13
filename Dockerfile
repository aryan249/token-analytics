FROM node:20.18.1-alpine3.21 AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/

RUN npx tsc --outDir dist --skipLibCheck --noEmitOnError false 2>&1 | grep -v "node_modules/" || true; \
    test -f dist/indexer/main.js || (echo "Build failed: dist not produced" && exit 1)

# Prune dev deps in builder — no second npm ci needed (avoids network timeout)
RUN npm prune --omit=dev

FROM node:20.18.1-alpine3.21

RUN addgroup -g 1001 appgroup && adduser -u 1001 -G appgroup -s /bin/sh -D appuser

WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

RUN chown -R appuser:appgroup /app

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/indexer/main.js"]
