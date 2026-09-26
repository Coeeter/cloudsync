import { Effect, Redacted } from "effect"
import { Database } from "./index"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is required")

const layer = Database.layer({
  connectionString: Redacted.make(url),
  migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
})

await Effect.runPromise(Effect.scoped(Database.pipe(Effect.provide(layer))))
