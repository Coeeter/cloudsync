# syntax=docker/dockerfile:1.7

# Build output is plain JavaScript, so the builder runs on the host architecture and only the
# runtime stage targets the deployment platform.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-debian AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json bun.lock turbo.json tsconfig.json biome.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bunx turbo run build --filter=@cloudsync/cloud

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-debian AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json bun.lock ./
COPY apps/cloud/package.json apps/cloud/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --production --filter @cloudsync/cloud

FROM oven/bun:1.4.2-debian AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
  PORT=3000 \
  MIGRATIONS_DIR=/app/packages/db/drizzle
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/cloud/node_modules ./apps/cloud/node_modules
COPY --from=build /app/apps/cloud/.output ./apps/cloud/.output
COPY --from=build /app/apps/cloud/dist-worker ./apps/cloud/dist-worker
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health'); process.exit(r.ok ? 0 : 1)"]
# Web by default; run the worker from the same image with:
#   bun apps/cloud/dist-worker/worker.js
CMD ["bun", "apps/cloud/.output/server/index.mjs"]
