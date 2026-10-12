import { randomUUID } from "node:crypto"
import { Database } from "@cloudsync/db"
import { Effect, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { authenticated } from "../shared/zip-protocol"
import { CloudConfig } from "./config"
import { now } from "./persistence/catalog"
import type { ArchiveRow } from "./services/archives"
import { Storage } from "./services/storage"

export interface ZipCallback {
  readonly jobId: string
  readonly fingerprint: string
  readonly action: string
  readonly leaseToken?: string
  readonly processed?: number
  readonly objectKey?: string
  readonly error?: string
}

const reply = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.jsonUnsafe(body, { status })

export const applyZipCallback = (payload: ZipCallback) =>
  Effect.gen(function* () {
    const database = yield* Database
    const storage = yield* Storage
    if (!/^[0-9a-f-]{36}$/.test(payload.jobId) || typeof payload.fingerprint !== "string")
      return reply(400, { error: "Invalid request" })
    const row = yield* database.execute("zip.callback", (db) =>
      db.first<ArchiveRow>(
        "SELECT * FROM archives WHERE id=? AND fingerprint=? AND expiresAt>?",
        payload.jobId,
        payload.fingerprint,
        now(),
      ),
    )
    if (!row) return reply(404, { error: "Unknown archive" })
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
      return claimed
        ? reply(200, { leaseToken: token })
        : reply(409, { error: "Already claimed or finished" })
    }
    const leaseToken = payload.leaseToken
    if (!leaseToken || row.leaseToken !== leaseToken) return reply(409, { error: "Stale lease" })
    if (payload.action === "progress") {
      const processed = payload.processed
      if (!Number.isInteger(processed) || Number(processed) < 0 || Number(processed) > row.total)
        return reply(400, { error: "Invalid progress" })
      yield* database.execute("zip.progress", (db) =>
        db.run(
          "UPDATE archives SET processed=max(processed,?) WHERE id=? AND leaseToken=? AND status='building'",
          Number(processed),
          row.id,
          leaseToken,
        ),
      )
    } else if (payload.action === "completed") {
      const expected = `downloads/${row.id}/${leaseToken}.zip`
      if (payload.objectKey !== expected) return reply(400, { error: "Invalid output" })
      yield* storage.head(expected)
      yield* database.execute("zip.complete", (db) =>
        db.run(
          "UPDATE archives SET status='completed',objectKey=?,processed=total,error=NULL WHERE id=? AND leaseToken=? AND status IN ('building','uploading')",
          expected,
          row.id,
          leaseToken,
        ),
      )
    } else if (payload.action === "failed") {
      yield* database.execute("zip.failed", (db) =>
        db.run(
          "UPDATE archives SET status='failed',error=? WHERE id=? AND leaseToken=? AND status IN ('building','uploading')",
          String(payload.error ?? "ZIP creation failed").slice(0, 1000),
          row.id,
          leaseToken,
        ),
      )
    } else return reply(400, { error: "Invalid action" })
    return reply(200, { ok: true })
  })

export const zipCallback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* CloudConfig
  const body = yield* request.text
  if (
    !authenticated(Redacted.value(config.zipServiceSecret), body, {
      get: (name) => request.headers[name] ?? null,
    })
  )
    return reply(401, { error: "Unauthorized" })
  return yield* applyZipCallback(JSON.parse(body) as ZipCallback)
}).pipe(Effect.orElseSucceed(() => reply(500, { error: "Callback failed" })))
