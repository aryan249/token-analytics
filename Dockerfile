FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["ts-node", "--transpile-only", "src/indexer/main.ts"]