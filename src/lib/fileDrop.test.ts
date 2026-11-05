import { describe, expect, test } from "bun:test"

import { dropPointInCss } from "./fileDrop"

describe("dropPointInCss", () => {
  test("scales WebView2's device pixels down to CSS pixels", () => {
    expect(dropPointInCss({ x: 300, y: 150 }, true, 1.5)).toEqual({ x: 200, y: 100 })
  })

  test("takes WebKit's view points as they are, whatever the scale", () => {
    expect(dropPointInCss({ x: 300, y: 150 }, false, 2)).toEqual({ x: 300, y: 150 })
  })
})
