import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
const value = (await Bun.stdin.text()).trimEnd()
const name = process.env.ZIP_SECRET_PARAMETER
if (!name?.startsWith("/cloudsync/") || !value || Buffer.byteLength(value) > 4096)
  throw new Error("Invalid standard ZIP secret parameter")
await new SSMClient({ region: "ap-southeast-1" }).send(
  new PutParameterCommand({
    Name: name,
    Value: value,
    Type: "SecureString",
    Tier: "Standard",
    Overwrite: true,
  }),
)
console.log("ZIP secret parameter updated")
