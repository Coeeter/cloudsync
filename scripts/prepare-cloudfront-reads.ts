import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

const environment = process.argv[2]
if (environment !== "dev" && environment !== "prod")
  throw new Error("Usage: bun scripts/prepare-cloudfront-reads.ts dev|prod [--apply-dev]")
const apply = process.argv.includes("--apply-dev")
if (apply && environment !== "dev") throw new Error("Only development changes can be applied here")
const project = "cloudsync"
const distributionId = environment === "dev" ? "EDEVEXAMPLE000" : "EPRODEXAMPLE00"
const functionName = `${project}-download-response-${environment}`
const directory = resolve(`tmp/cloudfront-reads/${environment}`)
await mkdir(directory, { recursive: true })
async function aws(args: string[]) {
  const child = Bun.spawn(["aws", ...args, "--output", "json"], { stdout: "pipe", stderr: "pipe" })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(error)
  return output.trim() ? JSON.parse(output) : undefined
}
const account = (await aws(["sts", "get-caller-identity"])).Account
const functionArn = `arn:aws:cloudfront::${account}:function/${functionName}`
const snapshot = await aws(["cloudfront", "get-distribution-config", "--id", distributionId])
await writeFile(`${directory}/distribution-before.json`, JSON.stringify(snapshot, null, 2))
const originalConfig = structuredClone(snapshot.DistributionConfig)
const config = snapshot.DistributionConfig
const behaviors = config.CacheBehaviors.Items ?? []

for (const behavior of [config.DefaultCacheBehavior, ...behaviors]) {
  const associations = behavior.FunctionAssociations.Items ?? []
  if (
    associations.some(
      (association: { EventType: string; FunctionARN: string }) =>
        association.EventType === "viewer-response" && association.FunctionARN !== functionArn,
    )
  )
    throw new Error("Existing viewer-response function must be reconciled before applying")
  behavior.FunctionAssociations = {
    Quantity:
      associations.filter(
        (association: { EventType: string }) => association.EventType !== "viewer-response",
      ).length + 1,
    Items: [
      ...associations.filter(
        (association: { EventType: string }) => association.EventType !== "viewer-response",
      ),
      { EventType: "viewer-response", FunctionARN: functionArn },
    ],
  }
}
await writeFile(`${directory}/distribution.json`, JSON.stringify(config, null, 2))

await writeFile(
  `${directory}/function-config.json`,
  JSON.stringify({
    Comment: "Per-request attachment metadata for signed CloudFront downloads",
    Runtime: "cloudfront-js-2.0",
  }),
)
await writeFile(
  `${directory}/function.js`,
  await readFile(resolve("infra/cloudfront-download-response.js")),
)
if (apply) {
  const functions = await aws(["cloudfront", "list-functions"])
  const existing = functions.FunctionList?.Items?.find(
    (item: { Name: string }) => item.Name === functionName,
  )
  const updated = existing
    ? await aws([
        "cloudfront",
        "update-function",
        "--name",
        functionName,
        "--if-match",
        (await aws(["cloudfront", "describe-function", "--name", functionName])).ETag,
        "--function-config",
        `file://${directory}/function-config.json`,
        "--function-code",
        `fileb://${directory}/function.js`,
      ])
    : await aws([
        "cloudfront",
        "create-function",
        "--name",
        functionName,
        "--function-config",
        `file://${directory}/function-config.json`,
        "--function-code",
        `fileb://${directory}/function.js`,
      ])
  await aws(["cloudfront", "publish-function", "--name", functionName, "--if-match", updated.ETag])
  if (!isDeepStrictEqual(config, originalConfig))
    await aws([
      "cloudfront",
      "update-distribution",
      "--id",
      distributionId,
      "--if-match",
      snapshot.ETag,
      "--distribution-config",
      `file://${directory}/distribution.json`,
    ])
}
console.log(
  JSON.stringify({ environment, distributionId, functionName, directory, applied: apply }),
)
