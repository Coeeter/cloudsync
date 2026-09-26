import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import postgres, { type Sql } from "postgres"
import * as schema from "./schema"

const MIGRATION_LOCK = 724_031_806

export type CloudSyncDatabase = PostgresJsDatabase<typeof schema> & { $client: Sql }

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  reason: Schema.Literals(["unique", "foreign_key", "connection", "query"]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface DatabaseShape {
  readonly execute: <A>(
    name: string,
    operation: (database: CloudSyncDatabase) => Promise<A>,
  ) => Effect.Effect<A, DatabaseError>
  readonly transaction: <A>(
    name: string,
    operation: Parameters<CloudSyncDatabase["transaction"]>[0],
  ) => Effect.Effect<A, DatabaseError>
}

function databaseError(cause: unknown): DatabaseError {
  const nested = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause
  let reason: DatabaseError["reason"] = "query"
  if (nested instanceof postgres.PostgresError) {
    if (nested.code === "23505") reason = "unique"
    else if (nested.code === "23503") reason = "foreign_key"
    else if (nested.code.startsWith("08")) reason = "connection"
  } else if (
    nested instanceof Error &&
    "code" in nested &&
    typeof nested.code === "string" &&
    (nested.code === "ECONNREFUSED" || nested.code === "CONNECT_TIMEOUT")
  ) {
    reason = "connection"
  }
  return new DatabaseError({
    reason,
    message: nested instanceof Error ? nested.message : "Database operation failed",
    cause,
  })
}

export class Database extends Context.Service<Database, DatabaseShape>()("@cloudsync/db/Database") {
  static layer(options: {
    readonly connectionString: Redacted.Redacted<string>
    readonly migrationsFolder?: string
  }) {
    return Layer.effect(
      Database,
      Effect.gen(function* () {
        const client = yield* Effect.acquireRelease(
          Effect.sync(() =>
            postgres(Redacted.value(options.connectionString), {
              max: 10,
              prepare: false,
              connection: { client_min_messages: "warning" },
            }),
          ),
          (sql) => Effect.promise(() => sql.end()),
        )
        const database = drizzle(client, { schema })
        const db = Object.assign(database, { $client: client }) as CloudSyncDatabase
        const execute: DatabaseShape["execute"] = (name, operation) =>
          Effect.tryPromise({
            try: () => operation(db),
            catch: databaseError,
          }).pipe(Effect.withSpan(`Database.${name}`))

        if (options.migrationsFolder) {
          yield* Effect.logInfo("Applying database migrations")
          const migrationsFolder = options.migrationsFolder
          // Web and worker start together; the advisory lock serialises their migrations.
          yield* Effect.tryPromise({
            try: async () => {
              // A dedicated single connection so the session-scoped lock and the migration share it.
              const session = postgres(Redacted.value(options.connectionString), {
                max: 1,
                prepare: false,
                connection: { client_min_messages: "warning" },
              })
              try {
                await session`select pg_advisory_lock(${MIGRATION_LOCK})`
                await migrate(drizzle(session, { schema }), { migrationsFolder })
              } finally {
                await session.end()
              }
            },
            catch: databaseError,
          }).pipe(Effect.withSpan("Database.migrate"))
        }

        const transaction: DatabaseShape["transaction"] = (name, operation) =>
          execute(name, (database) => database.transaction(operation) as Promise<never>)

        return Database.of({ execute, transaction })
      }),
    )
  }
}

export { schema }
