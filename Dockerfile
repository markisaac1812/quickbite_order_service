# ---------- stage 1: build (compiles TypeScript -> dist/) ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Manifests first so `npm ci` stays cached until dependencies change.
COPY package*.json ./

# All dependencies, including devDependencies (typescript) needed to build.
RUN npm ci

COPY . .

RUN npm run build

# ---------- stage 2: runtime (what ECS runs) ----------
FROM node:22-alpine

ENV NODE_ENV=production

# tini as PID 1: forwards SIGTERM from ECS to node (so the graceful shutdown
# in server.ts / worker.ts runs) and reaps zombie processes.
RUN apk add --no-cache tini

WORKDIR /app

COPY package*.json ./

# Production dependencies only — no typescript, tsx or test tooling.
RUN npm ci --omit=dev

# Only the compiled output from the builder stage.
COPY --from=builder /app/dist ./dist

# One image, three roles (pick with the container command):
#   API      node dist/server.js        (default)
#   worker   node dist/worker.js        (assignment, outbox drain, archival)
#   migrate  npm run migrate:all:prod   (one-off task before a deploy)
EXPOSE 4000

# Drop root: run as the built-in unprivileged "node" user.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
