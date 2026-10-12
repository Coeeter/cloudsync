// stdout is deliberately limited to Wrangler's secret payload; never run this without a pipe.
const names = [
  "OWNER_EMAIL",
  "SESSION_SECRET",
  "PUBLIC_URL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "S3_BUCKET",
  "CLOUDFRONT_URL",
  "CLOUDFRONT_COOKIE_DOMAIN",
  "CLOUDFRONT_KEY_PAIR_ID",
  "CLOUDFRONT_PRIVATE_KEY_BASE64",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "ZIP_SERVICE_URL",
  "ZIP_SERVICE_SECRET",
]
if (process.stdout.isTTY) throw new Error("Pipe the secret payload directly to Wrangler")
const required = names.filter((n) => !["AWS_SESSION_TOKEN", "ZIP_SERVICE_URL"].includes(n))
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`)
const payload = Object.fromEntries(
  names.filter((n) => !!process.env[n]).map((n) => [n, process.env[n]]),
)
process.stdout.write(JSON.stringify(payload))
