import { describe, expect, it } from "bun:test"

import { emptyHistory } from "@/lib/annotations"

import {
  globalPointFrom,
  parseMovedTabPayload,
  windowAtPoint,
  type MovedTabPayload,
} from "./tabMove"

const document = {
  id: 7,
  numPages: 3,
  outline: [],
  pages: [
    { height: 400, rotation: 0, width: 300 },
    { height: 400, rotation: 90, width: 300 },
    { height: 400, rotation: 0, width: 300 },
  ],
  path: "/tmp/moved.pdf",
}

const payload: MovedTabPayload = {
  document,
  dirty: true,
  name: "moved.pdf",
  path: "/tmp/moved.pdf",
  recentPath: "/tmp/moved.pdf",
  recentView: {
    position: { fractionX: 0.25, fractionY: 0.5, pageNumber: 2 },
    viewMode: "book",
    zoom: { customScale: 1.25, fitPage: 2, mode: "custom" },
  },
  saveAsDefaultName: "moved",
  savable: false,
  saveRequired: false,
  seed: {
    hasMergedPages: true,
    history: {
      ...emptyHistory,
      past: [
        {
          command: {
            config: {
              direction: "ascending",
              layout: "single",
              text: "draft",
              widthRatio: 0.5,
            },
            kind: "watermark",
            pageCount: 3,
            previous: null,
          },
          id: 1,
        },
      ],
      savedId: 0,
    },
    marks: [[1, [11, 12, 13]]],
    pageRotations: [0, 90, 0],
    viewMode: "book",
  },
}

const rects = [
  { height: 600, label: "main", width: 800, x: 0, y: 0 },
  { height: 600, label: "window-2", width: 800, x: 1000, y: 200 },
]

describe("globalPointFrom", () => {
  it("puts viewport pixels on the screen's, at the window's scale", () => {
    expect(
      globalPointFrom({ x: 100, y: 50 }, { x: 1920, y: 1080 }, 1.5),
    ).toEqual({ x: 2070, y: 1155 })
  })

  it("keeps points beyond the viewport linear, where a held drag goes", () => {
    expect(
      globalPointFrom({ x: -40, y: 900 }, { x: 100, y: 100 }, 2),
    ).toEqual({ x: 20, y: 1900 })
  })
})

describe("windowAtPoint", () => {
  it("names the window whose rect holds the point", () => {
    expect(windowAtPoint({ x: 1200, y: 400 }, rects)?.label ?? null).toBe(
      "window-2",
    )
    expect(windowAtPoint({ x: 10, y: 10 }, rects)?.label ?? null).toBe("main")
  })

  it("answers null past every edge, not the nearest window", () => {
    expect(windowAtPoint({ x: 900, y: 300 }, rects)).toBeNull()
    expect(windowAtPoint({ x: 1801, y: 200 }, rects)).toBeNull()
    expect(windowAtPoint({ x: 1000, y: 800 }, rects)).toBeNull()
  })

  it("takes the only window holding the point, and none for an empty list", () => {
    expect(windowAtPoint({ x: 0, y: 0 }, rects)?.label ?? null).toBe("main")
    expect(windowAtPoint({ x: 10, y: 10 }, [])).toBeNull()
  })

  it("resolves stacked windows to the newest face on the screen", () => {
    const stacked = [
      { height: 600, label: "main", width: 800, x: 0, y: 0 },
      { height: 600, label: "window-2", width: 800, x: 32, y: 32 },
      { height: 600, label: "window-3", width: 800, x: 64, y: 64 },
    ]

    // Hash order put the oldest first; the point sits in all three.
    expect(windowAtPoint({ x: 100, y: 100 }, stacked)?.label ?? null).toBe(
      "window-3",
    )
  })

  it("prefers the focused window wherever the stack overlaps", () => {
    const stacked = [
      { focused: true, height: 600, label: "window-2", width: 800, x: 32, y: 32 },
      { height: 600, label: "window-3", width: 800, x: 64, y: 64 },
    ]

    expect(windowAtPoint({ x: 100, y: 100 }, stacked)?.label ?? null).toBe(
      "window-2",
    )
  })

  it("answers the dragging window itself wherever only older windows stack behind it", () => {
    // The dragger holds focus for as long as the pointer is held; the older
    // window behind it has neither focus nor the newer face.
    const stacked = [
      { height: 600, label: "main", width: 800, x: 0, y: 0 },
      { focused: true, height: 600, label: "window-2", width: 800, x: 32, y: 32 },
    ]

    // A cascaded secondary window's own body mostly covers the older one
    // behind it: a release there tears off, it does not land out of sight.
    expect(
      windowAtPoint({ x: 100, y: 100 }, stacked, "window-2")?.label ?? null,
    ).toBe("window-2")
  })

  it("answers a newer window covering the dragging one, focus or not", () => {
    const stacked = [
      { focused: true, height: 600, label: "main", width: 800, x: 0, y: 0 },
      { height: 600, label: "window-2", width: 800, x: 32, y: 32 },
    ]

    // Dragging from the oldest window onto a newer one's coverage moves in:
    // the dragger's own focus says nothing about where it stacks.
    expect(windowAtPoint({ x: 100, y: 100 }, stacked, "main")?.label ?? null).toBe(
      "window-2",
    )
  })
})

describe("parseMovedTabPayload", () => {
  it("round-trips a payload the queue carried", () => {
    // The JSON the handoff queue carried, not the object that entered it.
    const parsed = parseMovedTabPayload(JSON.parse(JSON.stringify(payload)))

    expect(parsed).toEqual(payload)
  })

  it("drops optional fields it never carried rather than inventing them", () => {
    const parsed = parseMovedTabPayload({
      ...JSON.parse(JSON.stringify(payload)),
      recentPath: undefined,
      recentView: { position: { pageNumber: 0 } },
      saveAsDefaultName: undefined,
    })

    expect(parsed?.recentPath).toBeUndefined()
    expect(parsed?.recentView).toBeUndefined()
    expect(parsed?.saveAsDefaultName).toBeUndefined()
    expect(parsed?.seed.marks).toEqual([[1, [11, 12, 13]]])
  })

  it("refuses a payload whose document or seed came apart", () => {
    const valid = JSON.parse(JSON.stringify(payload))

    expect(parseMovedTabPayload(null)).toBeNull()
    expect(parseMovedTabPayload("moved.pdf")).toBeNull()
    expect(parseMovedTabPayload({ ...valid, document: { id: 7 } })).toBeNull()
    expect(
      parseMovedTabPayload({
        ...valid,
        seed: { ...valid.seed, viewMode: "spread" },
      }),
    ).toBeNull()
    expect(
      parseMovedTabPayload({
        ...valid,
        seed: { ...valid.seed, history: { past: [] } },
      }),
    ).toBeNull()
    expect(
      parseMovedTabPayload({
        ...valid,
        seed: { ...valid.seed, marks: [[1, ["11"]]] },
      }),
    ).toBeNull()
  })
})
