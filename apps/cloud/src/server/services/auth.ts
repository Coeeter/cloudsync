import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { Database, type DatabaseError, schema } from "@cloudsync/db"
import { CloudSyncError, Ok, Session } from "@cloudsync/domain"
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { Resend } from "resend"
import { CloudConfig } from "../config"

const PIN_LIFETIME_MS = 10 * 60 * 1000
const SESSION_LIFETIME_MS = 28 * 24 * 60 * 60 * 1000

export class EmailDeliveryError extends Schema.TaggedError<EmailDeliveryError>()(
  "EmailDeliveryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return decodeURIComponent(rest.join("="))
  }
  return undefined
}

const unauthorized = () =>
  new CloudSyncError({ code: "UNAUTHORIZED", message: "That code or session is no longer valid" })

export class Auth extends Context.Service<Auth, AuthShape>()("@cloudsync/cloud/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const config = yield* CloudConfig
      const database = yield* Database
      const resend = new Resend(Redacted.value(config.resend.apiKey))
      const ownerEmail = config.ownerEmail.trim().toLocaleLowerCase("en")
      const sessionSecret = Redacted.value(config.sessionSecret)
      const hashPin = (id: string, code: string) =>
        createHmac("sha256", sessionSecret).update(`${id}:${code}`).digest("hex")

      const requestPin: AuthShape["requestPin"] = Effect.fn("Auth.requestPin")(
        function* (emailInput) {
          const email = emailInput.trim().toLocaleLowerCase("en")
          if (email !== ownerEmail) return new Ok({ ok: true })

          const since = new Date(Date.now() - 15 * 60 * 1000)
          const count = yield* database.execute("auth.countRecentPins", async (db) => {
            const [result] = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(schema.authPins)
              .where(and(eq(schema.authPins.email, email), gt(schema.authPins.createdAt, since)))
            return result?.count ?? 0
          })
          if (count >= 5) {
            return yield* new CloudSyncError({
              code: "RATE_LIMITED",
              message: "Try again in a few minutes",
            })
          }

          const id = randomUUID()
          const code = randomInt(0, 1_000_000).toString().padStart(6, "0")
          yield* database.execute("auth.createPin", (db) =>
            db.insert(schema.authPins).values({
              id,
              email,
              codeHash: hashPin(id, code),
              expiresAt: new Date(Date.now() + PIN_LIFETIME_MS),
            }),
          )

          const result = yield* Effect.tryPromise({
            try: () =>
              resend.emails.send({
                from: config.resend.from,
                to: email,
                subject: `${code} is your CloudSync code`,
                text: `${code} is your CloudSync sign-in code. It expires in 10 minutes.`,
              }),
            catch: (cause) =>
              new EmailDeliveryError({
                message: cause instanceof Error ? cause.message : "Email delivery failed",
                cause,
              }),
          })
          if (result.error) {
            return yield* new EmailDeliveryError({
              message: result.error.message,
              cause: result.error,
            })
          }
          return new Ok({ ok: true })
        },
        (effect) =>
          effect.pipe(
            Effect.tapErrorTag("EmailDeliveryError", (error) =>
              Effect.logError("PIN email delivery failed").pipe(
                Effect.annotateLogs({ reason: error.message }),
              ),
            ),
            Effect.catchTag("EmailDeliveryError", () =>
              Effect.fail(
                new CloudSyncError({
                  code: "INTERNAL",
                  message: "The sign-in email could not be sent. Try again shortly.",
                }),
              ),
            ),
          ),
      )

      const verifyPin: AuthShape["verifyPin"] = Effect.fn("Auth.verifyPin")(
        function* (emailInput, code, _client) {
          const email = emailInput.trim().toLocaleLowerCase("en")
          if (email !== ownerEmail) return yield* unauthorized()

          const pin = yield* database.execute("auth.findPin", async (db) => {
            const [result] = await db
              .select()
              .from(schema.authPins)
              .where(
                and(
                  eq(schema.authPins.email, email),
                  isNull(schema.authPins.consumedAt),
                  gt(schema.authPins.expiresAt, new Date()),
                ),
              )
              .orderBy(desc(schema.authPins.createdAt))
              .limit(1)
            return result
          })
          if (!pin || pin.attempts >= 5) return yield* unauthorized()
          const actual = Buffer.from(hashPin(pin.id, code))
          const expected = Buffer.from(pin.codeHash)
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            yield* database.execute("auth.recordFailedAttempt", (db) =>
              db
                .update(schema.authPins)
                .set({ attempts: sql`${schema.authPins.attempts} + 1` })
                .where(eq(schema.authPins.id, pin.id)),
            )
            return yield* unauthorized()
          }

          const token = randomBytes(32).toString("base64url")
          const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS)
          yield* database.execute("auth.createSession", (db) =>
            db.transaction(async (tx) => {
              await tx
                .update(schema.authPins)
                .set({ consumedAt: new Date() })
                .where(eq(schema.authPins.id, pin.id))
              await tx
                .insert(schema.sessions)
                .values({ email, tokenHash: hashToken(token), expiresAt })
            }),
          )
          return new Session({ email, expiresAt: expiresAt.toISOString(), token })
        },
      )

      const authenticate: AuthShape["authenticate"] = Effect.fn("Auth.authenticate")(
        function* (explicitToken, cookieHeader) {
          const token = explicitToken ?? cookieValue(cookieHeader, "cloudsync_session")
          if (!token) return yield* unauthorized()
          const session = yield* database.execute("auth.findSession", async (db) => {
            const [result] = await db
              .select()
              .from(schema.sessions)
              .where(
                and(
                  eq(schema.sessions.tokenHash, hashToken(token)),
                  gt(schema.sessions.expiresAt, new Date()),
                ),
              )
              .limit(1)
            return result
          })
          if (!session || session.email !== ownerEmail) return yield* unauthorized()
          yield* database.execute("auth.touchSession", (db) =>
            db
              .update(schema.sessions)
              .set({ lastSeenAt: new Date() })
              .where(eq(schema.sessions.id, session.id)),
          )
          return new Session({ email: session.email, expiresAt: session.expiresAt.toISOString() })
        },
      )

      const revoke: AuthShape["revoke"] = (cookieHeader) => {
        const token = cookieValue(cookieHeader, "cloudsync_session")
        if (!token) return Effect.void
        return database
          .execute("auth.revoke", (db) =>
            db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token))),
          )
          .pipe(Effect.ignore)
      }

      return Auth.of({ requestPin, verifyPin, authenticate, revoke })
    }),
  )
}
