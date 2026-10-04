import { describe, expect, test } from "bun:test"
import { isAnimatedWebP } from "./webp"

const container = (kind: string, payload: ReadonlyArray<number>) => {
  const chunkSize = payload.length
  const paddedSize = chunkSize + (chunkSize & 1)
  const bytes = new Uint8Array(12 + 8 + paddedSize)
  bytes.set(Buffer.from("RIFF"), 0)
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set(Buffer.from("WEBP"), 8)
  bytes.set(Buffer.from(kind), 12)
  new DataView(bytes.buffer).setUint32(16, chunkSize, true)
  bytes.set(payload, 20)
  return bytes
}

describe("isAnimatedWebP", () => {
  test("recognizes the VP8X animation flag", () => {
    expect(isAnimatedWebP(container("VP8X", [0x02]))).toBe(true)
  })

  test("recognizes a static VP8X image", () => {
    expect(isAnimatedWebP(container("VP8X", [0x10]))).toBe(false)
  })

  test("recognizes the ANIM chunk", () => {
    expect(isAnimatedWebP(container("ANIM", [0, 0, 0, 0, 0, 0]))).toBe(true)
  })

  test("treats other formats with a .webp name as not animated", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
    expect(isAnimatedWebP(png)).toBe(false)
  })

  test("rejects truncated containers", () => {
    expect(() => isAnimatedWebP(container("VP8X", [0x02]).subarray(0, 12))).toThrow()
  })
})
