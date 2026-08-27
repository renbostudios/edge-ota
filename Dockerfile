FROM node:20-alpine AS base

# Install pnpm 9 and dependencies needed for compilation
RUN npm install -g pnpm@9 && apk add --no-cache python3 make g++

WORKDIR /app

# Copy pnpm configuration and workspaces
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/server-node/package.json ./apps/server-node/

# Install dependencies (including devDependencies to compile TypeScript and native better-sqlite3)
RUN pnpm install --no-frozen-lockfile

# Copy workspace source files
COPY packages/core ./packages/core
COPY apps/server-node ./apps/server-node

# Compile TypeScript packages
RUN pnpm --filter @renbostudios/edge-ota-core build
RUN pnpm --filter @edge-ota/server-node build

# Use the compiled workspace from the builder stage directly

# Runner image
FROM node:20-alpine AS runner
WORKDIR /app

# Install runtime dependencies for better-sqlite3 if needed
RUN apk add --no-cache libstdc++

COPY --from=base /app /app

EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "apps/server-node/dist/index.js"]
