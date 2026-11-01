import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose"
import { verifyAccessToken } from "./auth"

const expected = { teamDomain: "team.cloudflareaccess.com", audience: "app-aud" }
const signing = await generateKeyPair("RS256")
const stranger = await generateKeyPair("RS256")
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" }],
})

const token = (claims: JWTPayload, key = signing.privateKey) => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    email: "owner@example.test",
    iss: `https://${expected.teamDomain}`,
    aud: expected.audience,
    iat: now,
    exp: now + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(key)
}

const verify = async (jwt: string) =>
  Effect.runPromise(verifyAccessToken(jwt, keys, expected).pipe(Effect.result))

describe("verifyAccessToken", () => {
  it("accepts a token Access issued for this application", async () => {
    const result = await verify(await token({}))
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") expect(result.success.email).toBe("owner@example.test")
  })

  it.each([
    ["another Access application", { aud: "other-aud" }],
    ["another Access team", { iss: "https://other.cloudflareaccess.com" }],
    ["an expired session", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["a service token without an email", { email: undefined }],
  ])("rejects %s", async (_, claims) => {
    const result = await verify(await token(claims))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("UNAUTHORIZED")
  })

  it("rejects a token signed by a key outside the team's key set", async () => {
    const result = await verify(await token({}, stranger.privateKey))
    expect(result._tag).toBe("Failure")
  })
})
