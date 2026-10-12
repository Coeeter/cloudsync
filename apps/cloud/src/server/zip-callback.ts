import { randomUUID } from "node:crypto"
import { Database } from "@cloudsync/db"
import { Effect, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { authenticated } from "../shared/zip-protocol"
import { CloudConfig } from "./config"
import { now } from "./persistence/catalog"
import type { ArchiveRow } from "./services/archives"
import { Storage } from "./services/storage"
export const zipCallback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* CloudConfig
  const database = yield* Database
  const storage = yield* Storage
  const body = yield* request.text
  if (
    !authenticated(Redacted.value(config.zipServiceSecret), body, {
      get: (name) => request.headers[name] ?? null,
    })
  )
    return HttpServerResponse.jsonUnsafe({ error: "Unauthorized" }, { status: 401 })
  const payload = JSON.parse(body) as {
    jobId: string
    fingerprint: string
    action: string
    leaseToken?: string
    processed?: number
    objectKey?: string
    error?: string
  }
  if (!/^[0-9a-f-]{36}$/.test(payload.jobId) || typeof payload.fingerprint !== "string")
    return HttpServerResponse.jsonUnsafe({ error: "Invalid request" }, { status: 400 })
  const row = yield* database.execute("zip.callback", (db) =>
    db.first<ArchiveRow>(
      "SELECT * FROM archives WHERE id=? AND fingerprint=? AND expiresAt>?",
      payload.jobId,
      payload.fingerprint,
      now(),
    ),
  )
  if (!row) return HttpServerResponse.jsonUnsafe({ error: "Unknown archive" }, { status: 404 })
  if (payload.action === "claim") {
    const token = randomUUID()
    const until = new Date(Date.now() + 16 * 60_000).toISOString()
    const claimed = yield* database.execute("zip.claim", (db) =>
      db.run(
        "UPDATE archives SET status='building',leaseToken=?,leaseUntil=?,attempts=attempts+1 WHERE id=? AND attempts<3 AND (status='pending' OR (status IN ('building','uploading') AND leaseUntil<?))",
        token,
        until,
        row.id,
        now(),
      ),
    )
    return HttpServerResponse.jsonUnsafe(
      claimed ? { leaseToken: token } : { error: "Already claimed or finished" },
      { status: claimed ? 200 : 409 },
    )
  }
  if (!payload.leaseToken || row.leaseToken !== payload.leaseToken)
    return HttpServerResponse.jsonUnsafe({ error: "Stale lease" }, { status: 409 })
  if (payload.action === "progress") {
    if (
      !Number.isInteger(payload.processed) ||
      Number(payload.processed) < 0 ||
      Number(payload.processed) > row.total
    )
      return HttpServerResponse.jsonUnsafe({ error: "Invalid progress" }, { status: 400 })
    yield* database.execute("zip.progress", (db) =>
      db.run(
        "UPDATE archives SET processed=max(processed,?) WHERE id=? AND leaseToken=? AND status='building'",
        payload.processed as number,
        row.id,
        payload.leaseToken as string,
      ),
    )
  } else if (payload.action === "completed") {
    const expected = `downloads/${row.id}/${payload.leaseToken}.zip`
    if (payload.objectKey !== expected)
      return HttpServerResponse.jsonUnsafe({ error: "Invalid output" }, { status: 400 })
    yield* storage.head(expected)
    yield* database.execute("zip.complete", (db) =>
      db.run(
        "UPDATE archives SET status='completed',objectKey=?,processed=total,error=NULL WHERE id=? AND leaseToken=? AND status IN ('building','uploading')",
        expected,
        row.id,
        payload.leaseToken as string,
      ),
    )
  } else if (payload.action === "failed") {
    yield* database.execute("zip.failed", (db) =>
      db.run(
        "UPDATE archives SET status='failed',error=? WHERE id=? AND leaseToken=? AND status IN ('building','uploading')",
        String(payload.error ?? "ZIP creation failed").slice(0, 1000),
        row.id,
        payload.leaseToken as string,
      ),
    )
  } else return HttpServerResponse.jsonUnsafe({ error: "Invalid action" }, { status: 400 })
  return HttpServerResponse.jsonUnsafe({ ok: true })
}).pipe(
  Effect.catch(() =>
    Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Callback failed" }, { status: 500 })),
  ),
)
