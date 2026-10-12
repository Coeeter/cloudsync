import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { AwsClient } from "aws4fetch"
const bucket = process.env.S3_BUCKET
const region = process.env.AWS_REGION ?? "ap-southeast-1"
if (!bucket?.endsWith("-dev") || process.env.S3_ENDPOINT)
  throw new Error("Requires the real development bucket; read-only metadata only")
try {
  const list = await new S3Client({ region }).send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: "objects/", MaxKeys: 1 }),
  )
  const key = list.Contents?.[0]?.Key
  if (!key) throw new Error("No development original available for read-only HEAD")
  const client = new AwsClient({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region,
    service: "s3",
    retries: 1,
  })
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}`
  const response = await client.fetch(url, {
    method: "HEAD",
    headers: { "x-amz-checksum-mode": "ENABLED" },
  })
  if (!response.ok) throw new Error("Development HEAD rejected")
  console.log(
    JSON.stringify({
      realDevSignedHead: response.status,
      checksumPresent: !!response.headers.get("x-amz-checksum-sha256"),
      sizeMatchesListing:
        Number(response.headers.get("content-length")) === list.Contents?.[0]?.Size,
    }),
  )
} catch {
  throw new Error("Read-only development HEAD validation did not complete")
}
