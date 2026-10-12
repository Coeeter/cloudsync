import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { Database, type DatabaseError } from "@cloudsync/db"
import { CloudSyncError, Ok, Session } from "@cloudsync/domain"
import { Context, Effect, Layer, Redacted } from "effect"
import { Resend } from "resend"
import { CloudConfig } from "../config"
import { now } from "../persistence/catalog"

const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const unauthorized = () =>
  new CloudSyncError({ code: "UNAUTHORIZED", message: "That code or session is no longer valid" })
function cookie(header: string | undefined) {
  try {
    return header
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("cloudsync_session="))
      ?.slice(18)
  } catch {
    return undefined
  }
}
interface Pin {
  id: string
  email: string
  codeHash: string
  attempts: number
  expiresAt: string
  consumedAt: string | null
}
interface SessionRow {
  id: string
  email: string
  expiresAt: string
}
export interface AuthShape {
  readonly requestPin: (email: string) => Effect.Effect<Ok, CloudSyncError | DatabaseError>
  readonly verifyPin: (
    email: string,
    code: string,
    client: "web" | "desktop",
  ) => Effect.Effect<Session, CloudSyncError | DatabaseError>
  readonly authenticate: (
    explicitToken: string | undefined,
    cookieHeader?: string,
  ) => Effect.Effect<Session, CloudSyncError | DatabaseError>
  readonly revoke: (cookieHeader: string | undefined) => Effect.Effect<void>
}
export class Auth extends Context.Service<Auth, AuthShape>()("@cloudsync/cloud/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const config = yield* CloudConfig
      const database = yield* Database
      const resend = new Resend(Redacted.value(config.resend.apiKey))
      const owner = config.ownerEmail.trim().toLocaleLowerCase("en")
      const pinHash = (id: string, code: string) =>
        createHmac("sha256", Redacted.value(config.sessionSecret))
          .update(`${id}:${code}`)
          .digest("hex")
      const requestPin: AuthShape["requestPin"] = (input) =>
        Effect.gen(function* () {
          const email = input.trim().toLocaleLowerCase("en")
          if (email !== owner) return Ok.make({ ok: true })
          const id = randomUUID()
          const code = randomInt(0, 1_000_000).toString().padStart(6, "0")
          const inserted = yield* database.execute("auth.pin", (db) =>
            db.run(
              `INSERT INTO auth_pins(id,email,codeHash,expiresAt,createdAt)
    SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM auth_pins WHERE email=? AND createdAt>?)<5`,
              id,
              email,
              pinHash(id, code),
              new Date(Date.now() + 10 * 60_000).toISOString(),
              now(),
              email,
              new Date(Date.now() - 15 * 60_000).toISOString(),
            ),
          )
          if (!inserted)
            return yield* new CloudSyncError({
              code: "RATE_LIMITED",
              message: "Try again in a few minutes",
            })
          yield* Effect.tryPromise({
            try: async () => {
              const result = await resend.emails.send({
                from: config.resend.from,
                to: email,
                subject: `${code} is your CloudSync code`,
                text: `${code} is your CloudSync sign-in code. It expires in 10 minutes.`,
              })
              if (result.error) throw new Error("Email rejected")
            },
            catch: () =>
              new CloudSyncError({
                code: "INTERNAL",
                message: "The sign-in email could not be sent. Try again shortly.",
              }),
          })
          return Ok.make({ ok: true })
        })
      const verifyPin: AuthShape["verifyPin"] = (input, code, _client) =>
        Effect.gen(function* () {
          const email = input.trim().toLocaleLowerCase("en")
          if (email !== owner) return yield* unauthorized()
          const pin = yield* database.execute("auth.findPin", (db) =>
            db.first<Pin>(
              "SELECT * FROM auth_pins WHERE email=? AND consumedAt IS NULL AND expiresAt>? ORDER BY createdAt DESC LIMIT 1",
              email,
              now(),
            ),
          )
          if (!pin || pin.attempts >= 5) return yield* unauthorized()
          const expected = Buffer.from(pin.codeHash)
          const actual = Buffer.from(pinHash(pin.id, code))
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            yield* database.execute("auth.attempt", (db) =>
              db.run(
                "UPDATE auth_pins SET attempts=attempts+1 WHERE id=? AND consumedAt IS NULL",
                pin.id,
              ),
            )
            return yield* unauthorized()
          }
          const token = Buffer.from(randomBytes(32)).toString("base64url")
          const expiresAt = new Date(Date.now() + 28 * 24 * 60 * 60_000).toISOString()
          yield* database
            .execute("auth.consume", (db) =>
              db.batch([
                [
                  "INSERT INTO assertions(value) SELECT CASE WHEN consumedAt IS NULL AND attempts<5 AND expiresAt>? THEN 1 ELSE 0 END FROM auth_pins WHERE id=?",
                  now(),
                  pin.id,
                ],
                ["UPDATE auth_pins SET consumedAt=? WHERE id=?", now(), pin.id],
                [
                  "INSERT INTO sessions(id,email,tokenHash,expiresAt,lastSeenAt,createdAt) VALUES(?,?,?,?,?,?)",
                  randomUUID(),
                  email,
                  hash(token),
                  expiresAt,
                  now(),
                  now(),
                ],
                ["DELETE FROM assertions"],
              ]),
            )
            .pipe(Effect.catchTag("DatabaseError", () => Effect.fail(unauthorized())))
          return Session.make({ email, expiresAt, token })
        })
      const authenticate: AuthShape["authenticate"] = (explicit, header) =>
        Effect.gen(function* () {
          const token = explicit ?? cookie(header)
          if (!token) return yield* unauthorized()
          const row = yield* database.execute("auth.session", (db) =>
            db.first<SessionRow>(
              "SELECT * FROM sessions WHERE tokenHash=? AND expiresAt>?",
              hash(token),
              now(),
            ),
          )
          if (!row || row.email !== owner) return yield* unauthorized()
          return Session.make({ email: row.email, expiresAt: row.expiresAt })
        })
      const revoke: AuthShape["revoke"] = (header) => {
        const token = cookie(header)
        return token
          ? database
              .execute("auth.revoke", (db) =>
                db.run("DELETE FROM sessions WHERE tokenHash=?", hash(token)),
              )
              .pipe(Effect.ignore)
          : Effect.void
      }
      return Auth.of({ requestPin, verifyPin, authenticate, revoke })
    }),
  )
}
