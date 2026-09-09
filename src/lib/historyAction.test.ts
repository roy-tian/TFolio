import { describe, expect, it } from "bun:test"

import type { AnnotationCommand } from "@/lib/annotations"
import { historyAction } from "@/lib/historyAction"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import { defaultWatermarkConfig } from "@/lib/watermark"

const pageNumbersConfigValue: PageNumbersConfig = {
  mode: "single",
  position: "bottomCenter",
  range: null,
  smartColor: true,
  start: null,
  blankNumbered: true,
  blankCounted: true,
}

const highlight: AnnotationCommand = {
  color: "#ffd54a",
  kind: "highlight",
  opacity: 0.4,
  targets: [
    { pageNumber: 1, quads: [{ height: 10, left: 0, top: 0, width: 50 }] },
  ],
}

describe("historyAction", () => {
  it("names a mark by the tool that made it", () => {
    expect(historyAction(highlight)).toEqual({ key: "annotate.actionHighlight" })
  })

  // The mark that went is not what the label is about: an erase is an erase
  // whichever tool drew what it took out.
  it("names an erase rather than the mark it erased", () => {
    expect(
      historyAction({
        kind: "eraseAnnotation",
        index: 0,
        pages: [1],
        target: { command: highlight, id: 1 },
      }),
    ).toEqual({ key: "annotate.actionErase" })
  })

  it("counts the pages a delete took", () => {
    expect(
      historyAction({
        kind: "deletePages",
        pages: [2, 3],
        pageCount: 5,
        stashId: 1,
      }),
    ).toEqual({ count: 2, key: "annotate.actionDeletePages" })
  })

  it("counts the pages a paste brought", () => {
    expect(
      historyAction({
        kind: "duplicatePages",
        index: 4,
        pageCount: 6,
        sourcePages: [1],
        stashId: 1,
      }),
    ).toEqual({ count: 1, key: "annotate.actionDuplicatePages" })
  })

  it("tells adding, changing and removing a watermark apart", () => {
    expect(
      historyAction({
        config: defaultWatermarkConfig("DRAFT"),
        kind: "watermark",
        pageCount: 3,
        previous: null,
      }),
    ).toEqual({ key: "annotate.actionWatermarkAdd" })
    expect(
      historyAction({
        config: defaultWatermarkConfig("FINAL"),
        kind: "watermark",
        pageCount: 3,
        previous: defaultWatermarkConfig("DRAFT"),
      }),
    ).toEqual({ key: "annotate.actionWatermarkChange" })
    expect(
      historyAction({
        config: null,
        kind: "watermark",
        pageCount: 3,
        previous: defaultWatermarkConfig("DRAFT"),
      }),
    ).toEqual({ key: "annotate.actionWatermarkRemove" })
  })

  it("tells adding, changing and removing page numbers apart", () => {
    expect(
      historyAction({
        config: pageNumbersConfigValue,
        kind: "pageNumbers",
        pageCount: 3,
        previous: null,
      }),
    ).toEqual({ key: "annotate.actionPageNumbersAdd" })
    expect(
      historyAction({
        config: { ...pageNumbersConfigValue, position: "bottomRight" },
        kind: "pageNumbers",
        pageCount: 3,
        previous: pageNumbersConfigValue,
      }),
    ).toEqual({ key: "annotate.actionPageNumbersChange" })
    expect(
      historyAction({
        config: null,
        kind: "pageNumbers",
        pageCount: 3,
        previous: pageNumbersConfigValue,
      }),
    ).toEqual({ key: "annotate.actionPageNumbersRemove" })
  })
})
