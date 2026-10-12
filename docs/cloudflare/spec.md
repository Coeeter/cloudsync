# Cloudsync Workers + D1 migration

Approved for local implementation by Nas on 2026-10-12. Supersedes the AWS DynamoDB migration. No commit, push, deployment, shared-state adoption, production writes, DNS changes, or paid fixtures are authorized.

Keep the single-owner archive, stable entry IDs, parent hierarchy, explicit empty directories, natural directory-first sorting, immediate child counts, path substring search, descendant covers, collision naming, restore-together trash, 30-day retention, verified upload finalization, existing desktop sessions, private S3 originals and CloudFront delivery. Original bytes and keys never change during migration.

Cloudflare Workers hosts the website/API; D1 SQLite owns metadata. Desktop and browser create previews, including PDF first pages via pdf.js. Missing desktop tools show a blocking startup page with the Homebrew command and restart instructions. Unsupported or undecodable files retain originals with a visible preview failure; there is no server preview renderer. JPEG previews are accepted alongside WebP.

ZIPs remain asynchronous, reusable for seven days, support Unicode/empty directories, and fail clearly on missing input or ordinary Lambda resource/time limits. Closing the browser does not stop a ZIP. An authenticated POST /zip/{id} accepts a validated manifest, returns promptly, and starts AWS Lambda work. Authenticated callbacks update D1. Duplicate delivery and interrupted submission/callbacks recover safely. No arbitrary browser-supplied object keys.

Resend remains the email provider. Doppler is the secret source; Wrangler owns Cloudflare deployment, Terraform owns AWS configuration. Preserve existing resources and research notes. Owner pauses ingestion, stops Dokploy, exports/imports/reconciles metadata, switches endpoint, then resumes; no dual writes or reverse converter.
