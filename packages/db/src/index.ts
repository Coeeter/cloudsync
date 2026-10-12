import { Context, Effect, Layer, Schema } from "effect"

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<A>(): Promise<{ results: A[]; meta: { changes: number } }>
  first<A>(): Promise<A | null>
  run(): Promise<{ meta: { changes: number } }>
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>
}
export type SqlValue = string | number | null
export type Statement = readonly [string, ...SqlValue[]]

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  reason: Schema.Literals(["unique", "foreign_key", "connection", "query"]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Sqlite {
  constructor(readonly binding: D1Database) {}
  prepare([sql, ...values]: Statement): D1PreparedStatement {
    return this.binding.prepare(sql).bind(...values)
  }
  async all<A>(sql: string, ...values: SqlValue[]): Promise<A[]> {
    return (await this.prepare([sql, ...values]).all<A>()).results
  }
  async first<A>(sql: string, ...values: SqlValue[]): Promise<A | null> {
    return this.prepare([sql, ...values]).first<A>()
  }
  async run(sql: string, ...values: SqlValue[]): Promise<number> {
    return (await this.prepare([sql, ...values]).run()).meta.changes
  }
  async batch(statements: readonly Statement[]): Promise<void> {
    if (statements.length) await this.binding.batch(statements.map((s) => this.prepare(s)))
  }
  async revision(): Promise<number> {
    return (
      (await this.first<{ value: number }>("SELECT value FROM revision WHERE id=1"))?.value ?? 0
    )
  }
  async commit(revision: number, statements: readonly Statement[]): Promise<void> {
    await this.batch([
      [
        "INSERT INTO assertions(value) SELECT CASE WHEN value=? THEN 1 ELSE 0 END FROM revision WHERE id=1",
        revision,
      ],
      ...statements,
      ["DELETE FROM assertions"],
    ])
  }
}

export interface DatabaseShape {
  readonly sql: Sqlite
  readonly execute: <A>(
    name: string,
    operation: (db: Sqlite) => Promise<A>,
  ) => Effect.Effect<A, DatabaseError>
}
export class Database extends Context.Service<Database, DatabaseShape>()("@cloudsync/db/Database") {
  static layer(binding: D1Database) {
    const db = new Sqlite(binding)
    return Layer.succeed(
      Database,
      Database.of({
        sql: db,
        execute: (name, operation) =>
          Effect.tryPromise({
            try: () => operation(db),
            catch: (cause) =>
              new DatabaseError({
                reason: String(cause).includes("UNIQUE constraint") ? "unique" : "query",
                message: "Database operation failed",
                cause,
              }),
          }).pipe(Effect.withSpan(`Database.${name}`)),
      }),
    )
  }
}
