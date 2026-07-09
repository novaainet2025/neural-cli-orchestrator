# Build Stage
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, etc.)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production Stage
FROM node:22-slim

WORKDIR /app

# Install runtime dependencies if any (e.g., sqlite3)
RUN apt-get update && apt-get install -y \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/config ./config
COPY --from=builder /app/db/migrations ./db/migrations
COPY --from=builder /app/.env.example ./.env.example

EXPOSE 6200 6201

# Run the app
CMD ["npm", "start"]
