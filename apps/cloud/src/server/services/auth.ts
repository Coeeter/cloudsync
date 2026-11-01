import { CloudSyncError, Session } from "@cloudsync/domain"
import { Context, Effect, Layer } from "effect"
import type { Headers } from "effect/unstable/http"
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose"
import { CloudConfig } from "../config"

const unauthorized = () =>
  new CloudSyncError({ code: "UNAUTHORIZED", message: "Your sign-in is no longer valid" })

const localOwner = Session.make({ email: "owner@localhost", expiresAt: "9999-12-31T00:00:00.000Z" })

export const verifyAccessToken = (
  token: string,
  keys: JWTVerifyGetKey,
  expected: { readonly teamDomain: string; readonly audience: string },
) =>
  Effect.tryPromise({
    try: () =>
      jwtVerify(token, keys, {
        issuer: `https://${expected.teamDomain}`,
        audience: expected.audience,
        algorithms: ["RS256"],
      }),
    catch: unauthorized,
  }).pipe(
    Effect.flatMap(({ payload }) =>
      typeof payload.email === "string" && typeof payload.exp === "number"
        ? Effect.succeed(
            Session.make({
              email: payload.email,
              expiresAt: new Date(payload.exp * 1000).toISOString(),
            }),
          )
        : Effect.fail(unauthorized()),
    ),
  )

export interface AuthShape {
  readonly mode: "access" | "local"
  readonly authenticate: (headers: Headers.Headers) => Effect.Effect<Session, CloudSyncError>
}

export class Auth extends Context.Service<Auth, AuthShape>()("@cloudsync/cloud/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const { access } = yield* CloudConfig
      if (access._tag === "LocalOwner")
        return Auth.of({ mode: "local", authenticate: () => Effect.succeed(localOwner) })
      // Access sets this header on every request it lets through, whether the client presented
      // the CF_Authorization cookie (browser) or a cf-access-token header (desktop).
      const keys = createRemoteJWKSet(new URL(`https://${access.teamDomain}/cdn-cgi/access/certs`))
      return Auth.of({
        mode: "access",
        authenticate: (headers) => {
          const token = headers["cf-access-jwt-assertion"]
          return token ? verifyAccessToken(token, keys, access) : Effect.fail(unauthorized())
        },
      })
    }),
  )
}
