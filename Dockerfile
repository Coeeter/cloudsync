# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-debian AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun build apps/cloud/src/lambda/zip.ts --target=node --format=esm --outdir=/artifact --entry-naming=zip.mjs

FROM public.ecr.aws/lambda/nodejs:22@sha256:a97a07535bdeedba37a9e4c5d6ac5d77f232ebd53d953817da7280932ddaaaa4
COPY --from=build /artifact/zip.mjs ${LAMBDA_TASK_ROOT}/zip.mjs
CMD ["zip.handler"]
