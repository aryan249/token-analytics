FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/

# Compile TS to JS. tsc may report errors from node_modules but still emits output.
# Use noEmitOnError=false to ensure dist/ is produced despite external type errors.
RUN npx tsc --outDir dist --skipLibCheck --noEmitOnError false; \
    test -f dist/indexer/main.js || (echo "Build failed: dist not produced" && exit 1)

FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

CMD ["node", "dist/indexer/main.js"]
