import { createPrivateKey } from "node:crypto"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"

export interface ResendDelivery {
  readonly apiKey: Redacted.Redacted<string>
  readonly from: string
}

export type CloudFrontSigning =
  | {
      readonly _tag: "Signed"
      readonly keyPairId: string
      readonly privateKeyPem: Redacted.Redacted<string>
    }
  | { readonly _tag: "LocalUnsigned" }

export interface CloudConfigShape {
  readonly nodeEnv: "development" | "test" | "production"
  readonly zipServiceUrl: string | null
  readonly zipServiceSecret: Redacted.Redacted<string>
  readonly ownerEmail: string
  readonly sessionSecret: Redacted.Redacted<string>
  readonly publicUrl: string
  readonly awsRegion: string
  readonly s3Bucket: string
  readonly s3Endpoint: string | null
  readonly s3PublicEndpoint: string | null
  readonly s3ForcePathStyle: boolean
  readonly cloudFrontUrl: string
  readonly cloudFrontCookieDomain: string | null
  readonly cloudFrontSigning: CloudFrontSigning
  readonly resend: ResendDelivery
}

const optionOrNull = <A>(option: Option.Option<A>): A | null => Option.getOrNull(option)

const RawConfig = Config.all({
  nodeEnv: Config.Literals(["development", "test", "production"], "NODE_ENV").pipe(
    Config.withDefault("development"),
  ),
  zipServiceUrl: Config.option(Config.NonEmptyString("ZIP_SERVICE_URL")).pipe(
    Config.map(optionOrNull),
  ),
  zipServiceSecret: Config.Redacted("ZIP_SERVICE_SECRET"),
  ownerEmail: Config.NonEmptyString("OWNER_EMAIL"),
  sessionSecret: Config.Redacted("SESSION_SECRET"),
  publicUrl: Config.NonEmptyString("PUBLIC_URL"),
  awsRegion: Config.NonEmptyString("AWS_REGION").pipe(Config.withDefault("ap-southeast-1")),
  s3Bucket: Config.NonEmptyString("S3_BUCKET"),
  s3Endpoint: Config.option(Config.NonEmptyString("S3_ENDPOINT")).pipe(Config.map(optionOrNull)),
  s3PublicEndpoint: Config.option(Config.NonEmptyString("S3_PUBLIC_ENDPOINT")).pipe(
    Config.map(optionOrNull),
  ),
  s3ForcePathStyle: Config.Boolean("S3_FORCE_PATH_STYLE").pipe(Config.withDefault(false)),
  cloudFrontUrl: Config.NonEmptyString("CLOUDFRONT_URL"),
  cloudFrontCookieDomain: Config.option(Config.NonEmptyString("CLOUDFRONT_COOKIE_DOMAIN")).pipe(
    Config.map(optionOrNull),
  ),
  cloudFrontKeyPairId: Config.option(Config.NonEmptyString("CLOUDFRONT_KEY_PAIR_ID")).pipe(
    Config.map(optionOrNull),
  ),
  // Dokploy truncates raw multiline PEM values, so this secret is always one-line base64.
  cloudFrontPrivateKeyBase64: Config.option(Config.Redacted("CLOUDFRONT_PRIVATE_KEY_BASE64")).pipe(
    Config.map(optionOrNull),
  ),
  resendApiKey: Config.Redacted("RESEND_API_KEY"),
  resendFrom: Config.NonEmptyString("RESEND_FROM"),
})

export class CloudConfig extends Context.Service<CloudConfig, CloudConfigShape>()(
  "@cloudsync/cloud/CloudConfig",
) {
  static readonly layer = Layer.effect(
    CloudConfig,
    Effect.gen(function* () {
      const raw = yield* RawConfig

      const hasSigningId = raw.cloudFrontKeyPairId !== null
      const hasSigningKey = raw.cloudFrontPrivateKeyBase64 !== null
      if (hasSigningId !== hasSigningKey) {
        return yield* Effect.die(
          new Error(
            "CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY_BASE64 must be configured together",
          ),
        )
      }
      if (raw.nodeEnv === "production" && (!hasSigningId || !hasSigningKey)) {
        return yield* Effect.die(
          new Error("CloudFront signing credentials are required in production"),
        )
      }
      if (raw.nodeEnv === "production" && !raw.cloudFrontCookieDomain) {
        return yield* Effect.die(new Error("CLOUDFRONT_COOKIE_DOMAIN is required in production"))
      }

      let cloudFrontSigning: CloudFrontSigning = { _tag: "LocalUnsigned" }
      if (raw.cloudFrontKeyPairId && raw.cloudFrontPrivateKeyBase64) {
        const privateKeyPem = yield* Effect.sync(() => {
          const decoded = Buffer.from(
            Redacted.value(raw.cloudFrontPrivateKeyBase64 as Redacted.Redacted<string>).trim(),
            "base64",
          ).toString("utf8")
          createPrivateKey(decoded)
          return Redacted.make(decoded)
        })
        cloudFrontSigning = {
          _tag: "Signed",
          keyPairId: raw.cloudFrontKeyPairId,
          privateKeyPem,
        }
      }

      return CloudConfig.of({
        nodeEnv: raw.nodeEnv,
        zipServiceUrl: raw.zipServiceUrl,
        zipServiceSecret: raw.zipServiceSecret,
        ownerEmail: raw.ownerEmail,
        sessionSecret: raw.sessionSecret,
        publicUrl: raw.publicUrl,
        awsRegion: raw.awsRegion,
        s3Bucket: raw.s3Bucket,
        s3Endpoint: raw.s3Endpoint,
        s3PublicEndpoint: raw.s3PublicEndpoint,
        s3ForcePathStyle: raw.s3ForcePathStyle,
        cloudFrontUrl: raw.cloudFrontUrl,
        cloudFrontCookieDomain: raw.cloudFrontCookieDomain,
        cloudFrontSigning,
        resend: { apiKey: raw.resendApiKey, from: raw.resendFrom },
      })
    }),
  )
}
