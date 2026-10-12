declare module "cloudflare:workers" {
  export const env: { DB: import("@cloudsync/db").D1Database }
}
