import { describe, expect, it } from "bun:test"
import { toggleSelection } from "./selection"

describe("Contact-sheet selection", () => {
  it("selects and deselects ranges in either direction without losing other selections", () => {
    const order = ["a", "b", "c", "d"]
    const selected = toggleSelection(new Set(["a"]), "d", order, "b", true)
    expect([...selected]).toEqual(order)
    expect([...toggleSelection(selected, "b", order, "d", true)]).toEqual(["a"])
  })
  it("falls back to a single toggle when the anchor is outside the current view", () => {
    expect([...toggleSelection(new Set(["a"]), "b", ["a", "b"], "old", true)]).toEqual(["a", "b"])
  })
})
