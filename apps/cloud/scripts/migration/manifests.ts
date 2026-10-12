import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { convert, verifySnapshot } from "./convert"
import { readSnapshot } from "./legacy"
const directory = process.argv[2]
if (!directory || process.env.MIGRATION_PUBLISH_MANIFESTS !== "authorized")
  throw new Error(
    "Manifest publication needs explicit authorization; set MIGRATION_PUBLISH_MANIFESTS=authorized",
  )
await verifySnapshot(directory)
const { manifests } = convert(await readSnapshot(directory))
const client = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" })
for (const m of manifests)
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: m.key,
      Body: m.body,
      ContentType: "application/json",
    }),
  )
console.log(JSON.stringify({ publishedManifests: manifests.length }))
