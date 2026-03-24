FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source and static assets
COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

# Default command (overridden per service in docker-compose)
CMD ["npx", "ts-node", "--transpile-only", "src/indexer/main.ts"]
