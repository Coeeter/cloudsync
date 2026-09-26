import { describe, expect, test } from "bun:test"
import { nextAvailableName, sanitizeRelativePath, splitExtension } from "./names"

describe("Finder-style collision names", () => {
  test("inserts suffix before an extension", () => {
    expect(nextAvailableName("image.png", ["image.png"])).toBe("image (2).png")
  })

  test("continues an existing suffix", () => {
    expect(nextAvailableName("image (2).png", ["image (2).png", "image (3).png"])).toBe(
      "image (4).png",
    )
  })

  test("uses case-insensitive NFC sibling identity", () => {
    expect(nextAvailableName("Café", ["CAFÉ"])).toBe("Café (2)")
  })

  test("preserves dotfiles", () => {
    expect(splitExtension(".keep")).toEqual({ stem: ".keep", extension: "" })
  })
})

describe("relative paths", () => {
  test("normalizes separators", () => {
    expect(sanitizeRelativePath("folder\\child/file.png")).toEqual(["folder", "child", "file.png"])
  })

  test("rejects traversal", () => {
    expect(() => sanitizeRelativePath("../outside")).toThrow("Invalid relative path")
  })
})
