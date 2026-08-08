# ── Build stage: compile src/ + Core/ to dist-server/ ────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: skip the `prepare` lifecycle (it runs `tsc` for the stdio
# build we don't need here); we build explicitly with build:server below.
RUN npm ci --ignore-scripts
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
# --omit=dev drops typescript etc.; --ignore-scripts stops the `prepare` script
# from running `tsc` (which is absent in prod) → the exit-code-127 build failure.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Compiled server + migrations (the prod migrator uses drizzle-orm, not drizzle-kit).
COPY --from=build /app/dist-server ./dist-server
COPY drizzle ./drizzle

EXPOSE 8080
CMD ["node", "dist-server/Core/index.js"]
