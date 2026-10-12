# Development and validation

Cloudsync now targets Cloudflare Workers + D1, with a Node Lambda for ZIPs. Production is still Dokploy/PostgreSQL until a separately authorized cutover. See [current plan](../cloudflare/plan.md) and [cutover](../cloudflare/cutover.md).

Doppler project cloudsync (dev/prod) is the runtime secret source; Resend remains email delivery. Never print secrets or signed URLs. The prepared release workflow pipes a selected Doppler payload directly to Wrangler. Lambda ZIP credentials use IAM; its webhook secret comes from one standard SSM SecureString outside Terraform state.

For entirely disposable local validation, use the pinned S3Mock service (`docker compose -f compose.dev.yml up -d s3`), ignored apps/cloud/.dev.vars with fake local credentials, and Wrangler's local D1. No real cloud object or paid fixture is needed. The separate postgres service is only for migration rehearsal, not the app runtime. Check existing processes before starting servers.

Run `bun run db:migrate`, `bun --filter @cloudsync/cloud dev`, and `bun --filter @cloudsync/cloud local:zip`. The cloud app uses port 3310; the ZIP bridge uses 3311/3312. scripts/local/env.sh contains only fake local credentials. For actual Node Lambda validation, run the compiled dist-lambda/zip.mjs in the Node 22 Runtime Interface Emulator and set ZIP_RIE_URL on the bridge. Docker must reach the dev server through host.docker.internal; --host 0.0.0.0 is only needed for this disposable local fixture.

`bun --filter @cloudsync/cloud test:e2e` drives real Workers RPC, D1, S3 PUT/HEADs and the ZIP bridge. scripts/local/browser.ts uses a separate Chrome instance for actual UI uploads/PDF/video/retry. Browser fixtures live under /tmp/cloudsync-preview-fixtures. scripts/local/benchmark.ts seeds roughly 75k fake metadata entries; it never touches real files. Local fixtures are deliberately opt-in and refuse nonlocal D1 endpoints.

Run `bun run check`, `bun run lint`, `bun run test`, and `bun run build`. The default test command skips opt-in end-to-end fixtures. Build output includes the compiled Worker and a small plain-JavaScript zip.mjs Lambda bundle. There is no cloud preview image, ffmpeg/Poppler server installation, DynamoDB adapter, derived snapshot worker or permanently polling process.

For authorized real-development CDN validation, scripts/validate-cloudfront-reads.ts creates disposable objects only in a -dev bucket and checks private/range/attachment behavior. It must not be run against production, and external fixture creation still needs authorization.

Desktop previews use local ffmpeg, pdftoppm and cwebp. Missing tools block archiving at startup with `brew install ffmpeg poppler webp` and restart instructions. Finder Homebrew paths are checked explicitly. Preview conversion failure preserves the verified original and allows browser retry; it does not enqueue server rendering. Browser PDF support lazy-loads pdf.js; WebP is preferred with JPEG fallback.

The macOS release remains `bun --filter @cloudsync/desktop package`. Replace the app only after owner authorization; preserve its user-data/Keychain session. Unfinished local validation must never use the production inbox or session as a fixture.
