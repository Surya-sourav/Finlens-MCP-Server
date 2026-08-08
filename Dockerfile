# ── Build stage: compile src/ + Core/ to dist-server/ ────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json ./
COPY src ./src
COPY Core ./Core
RUN npm run build:server

# ── Runtime stage: production deps only ──────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV QBO_MULTI_TENANT=true
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + migrations (the prod migrator uses drizzle-orm, not drizzle-kit).
COPY --from=build /app/dist-server ./dist-server
COPY drizzle ./drizzle

EXPOSE 8080
CMD ["node", "dist-server/Core/index.js"]
