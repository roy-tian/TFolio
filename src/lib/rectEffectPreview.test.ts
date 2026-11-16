import { describe, expect, it } from "bun:test"

import {
  MAX_RECT_EFFECT_PREVIEW_PIXELS,
  rectEffectPreviewScale,
  sourceCropForRect,
} from "@/lib/rectEffectPreview"

const rect = { height: 0.3, left: 0.2, top: 0.1, width: 0.4 }
const source = { height: 300, width: 200 }

describe("sourceCropForRect", () => {
  it("takes the displayed box's pixels from the page canvas", () => {
    expect(sourceCropForRect(rect, source)).toEqual({
      height: 90,
      left: 40,
      top: 30,
      width: 80,
    })
  })
})

describe("rectEffectPreviewScale", () => {
  it("keeps a small mosaic at source resolution", () => {
    expect(
      rectEffectPreviewScale(
        { height: 300, width: 200 },
        { kind: "mosaic", strength: 12 },
        2,
      ),
    ).toBe(1)
  })

  it("caps a full-page mosaic preview", () => {
    const scale = rectEffectPreviewScale(
      { height: 1754, width: 1240 },
      { kind: "mosaic", strength: 12 },
      1240 / 595,
    )

    expect(scale).toBeLessThan(1)
    expect(1240 * scale * (1754 * scale)).toBeLessThanOrEqual(
      MAX_RECT_EFFECT_PREVIEW_PIXELS + 1,
    )
  })

  it("includes blur padding in the same pixel budget", () => {
    const crop = { height: 1754, width: 1240 }
    const pixelsPerPoint = 1240 / 595
    const strength = 24
    const scale = rectEffectPreviewScale(
      crop,
      { kind: "blur", strength },
      pixelsPerPoint,
    )
    const padding = strength * pixelsPerPoint * scale * 3

    expect(
      (crop.width * scale + padding * 2) *
        (crop.height * scale + padding * 2),
    ).toBeLessThanOrEqual(MAX_RECT_EFFECT_PREVIEW_PIXELS + 1)
  })
})
