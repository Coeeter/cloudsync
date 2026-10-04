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

FROM oven/bun:1.4.2-debian AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg poppler-utils webp ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
  PORT=3000 \
  MIGRATIONS_DIR=/app/packages/db/drizzle
COPY --from=build /app/apps/cloud/.output ./apps/cloud/.output
COPY --from=build /app/apps/cloud/dist-worker ./apps/cloud/dist-worker
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health'); process.exit(r.ok ? 0 : 1)"]
# Web by default; run the worker from the same image with:
#   bun apps/cloud/dist-worker/worker.js
# The worker has no HTTP server, so its service must disable this HEALTHCHECK
# (Swarm: {"Test": ["NONE"]}) or it is restarted in a loop.
CMD ["bun", "apps/cloud/.output/server/index.mjs"]
