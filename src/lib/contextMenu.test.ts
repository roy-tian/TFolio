import { describe, expect, test } from "bun:test"

import { acceptsTypedText } from "./contextMenu"

describe("acceptsTypedText", () => {
  test("keeps the native menu over a text field", () => {
    expect(acceptsTypedText({ tagName: "INPUT", type: "text" })).toBe(true)
    expect(acceptsTypedText({ tagName: "INPUT", type: "number" })).toBe(true)
    expect(acceptsTypedText({ tagName: "TEXTAREA" })).toBe(true)
    expect(
      acceptsTypedText({ isContentEditable: true, tagName: "DIV" }),
    ).toBe(true)
  })

  test("drops it where a right-click hit no field at all", () => {
    expect(acceptsTypedText(null)).toBe(false)
    expect(acceptsTypedText({ tagName: "CANVAS" })).toBe(false)
    expect(
      acceptsTypedText({ isContentEditable: false, tagName: "DIV" }),
    ).toBe(false)
  })

  test("drops it over an input holding no text of its own", () => {
    expect(acceptsTypedText({ tagName: "INPUT", type: "checkbox" })).toBe(false)
    expect(acceptsTypedText({ tagName: "INPUT", type: "color" })).toBe(false)
    expect(acceptsTypedText({ tagName: "INPUT", type: "range" })).toBe(false)
  })

  test("drops it where the field takes no edit", () => {
    expect(
      acceptsTypedText({ disabled: true, tagName: "INPUT", type: "text" }),
    ).toBe(false)
    expect(acceptsTypedText({ readOnly: true, tagName: "TEXTAREA" })).toBe(
      false,
    )
  })
})
