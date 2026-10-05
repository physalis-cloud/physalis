FROM node:22-alpine AS base
# postgresql-client : nécessaire pour pg_dump (Phase 3 — archive avant
# DROP SCHEMA d'un client supprimé). openssl + libc6-compat : Prisma engine.
RUN apk add --no-cache libc6-compat openssl postgresql-client

# --- Full deps (build) ---
FROM base AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# --- Dev (hot-reload) ---
# node_modules vient de deps (devDeps inclus). Le source est monté en
# volume par docker-compose.dev.yml — ce COPY est juste pour prisma:generate.
FROM deps AS dev
WORKDIR /app
COPY . .
RUN npm run prisma:generate
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# --- Production deps (runtime + prisma cli) ---
FROM base AS prod-deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

# --- Build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run prisma:generate
RUN npm run build

# --- Runtime ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Version rendue par /api/health. Injectée au build : l'image publiée passe
# --build-arg depuis le workflow CI. Une construction locale (`docker compose
# up --build`) ne la passe pas ⇒ l'endpoint répond "unknown", comme avant.
ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION:-unknown}

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone server + static assets
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Production node_modules (includes prisma CLI with transitive deps)
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
# Prisma generated client (overrides the empty one from prod-deps)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
# Schema + migrations + package.json + bootstrap script
COPY --chown=nextjs:nodejs prisma ./prisma
COPY --chown=nextjs:nodejs package.json ./package.json
COPY --chown=nextjs:nodejs scripts ./scripts
# Modèles de workflow pré-remplis par l'onglet Installation (C-0051). Copiés
# explicitement en plus du tracing de next.config.ts : l'image ne dépend pas
# du seul tracing standalone (même garantie que le Dockerfile SaaS).
COPY --chown=nextjs:nodejs docs/*.modele.yml ./docs/

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js migrate deploy && node ./scripts/bootstrap-admin.mjs && node server.js"]
