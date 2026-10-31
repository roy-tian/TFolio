import { describe, expect, test } from "bun:test"

import {
  addSources,
  assembleSlots,
  deleteSlots,
  emptyPlan,
  insertBlank,
  moveGroup,
  moveSlots,
  organizeOutline,
  outputPages,
  removeGroups,
  rotateSlots,
  setOptions,
  sourceFromInfo,
  type OrganizePlan,
  type OrganizeSource,
} from "./organize"

const portrait = { height: 300, rotation: 0, width: 200 }

function source(id: number, pageCount: number, outline: OrganizeSource["outline"] = []): OrganizeSource {
  return {
    id,
    kind: "pdf",
    outline,
    pages: Array.from({ length: pageCount }, () => portrait),
    path: `/files/file-${id}.pdf`,
    title: `file-${id}`,
  }
}

function setup(...added: OrganizeSource[]) {
  const sources = new Map(added.map((item) => [item.id, item]))

  return { plan: addSources(emptyPlan, added), sources }
}

/** Each output page as `sourceId:pageNumber`, `blank`, or `pad`. */
function layout(plan: OrganizePlan, sources: Map<number, OrganizeSource>) {
  return outputPages(plan, sources).map((page) =>
    page.kind === "padding"
      ? "pad"
      : page.slot.kind === "blank"
        ? "blank"
        : `${page.slot.sourceId}:${page.slot.pageNumber}`,
  )
}

function keysOf(plan: OrganizePlan, ...labels: string[]) {
  const all = plan.groups.flatMap((group) => group.slots)

  return new Set(
    labels.map((label) => {
      const [sourceId, pageNumber] = label.split(":").map(Number)
      const slot = all.find(
        (candidate) =>
          candidate.kind === "page" &&
          candidate.sourceId === sourceId &&
          candidate.pageNumber === pageNumber,
      )

      return slot!.key
    }),
  )
}

describe("sourceFromInfo", () => {
  test("titles a source by its file name without the extension", () => {
    const made = sourceFromInfo({
      id: 4,
      kind: "word",
      outline: [],
      pages: [portrait],
      path: "C:\\Users\\me\\Q3 report.docx",
    })

    expect(made?.title).toBe("Q3 report")
  })

  test("refuses a file the backend could not read", () => {
    expect(
      sourceFromInfo({ kind: "pdf", outline: [], pages: [], path: "/broken.pdf" }),
    ).toBeNull()
  })
})

describe("plan edits", () => {
  test("adds each source as a group of its pages, in order", () => {
    const { plan, sources } = setup(source(1, 2), source(2, 1))

    expect(plan.groups.map((group) => group.title)).toEqual(["file-1", "file-2"])
    expect(layout(plan, sources)).toEqual(["1:1", "1:2", "2:1"])
  })

  test("moves pages across files, into the target group before the anchor", () => {
    const { plan, sources } = setup(source(1, 3), source(2, 2))
    const anchor = [...keysOf(plan, "2:2")][0]!
    const moved = moveSlots(plan, keysOf(plan, "1:3", "1:1"), plan.groups[1]!.id, anchor)

    expect(layout(moved, sources)).toEqual(["1:2", "2:1", "1:1", "1:3", "2:2"])
    expect(moved.groups[1]!.slots).toHaveLength(4)
  })

  test("moves to a group's end, and refuses a moving page as its own anchor", () => {
    const { plan, sources } = setup(source(1, 2), source(2, 1))
    const keys = keysOf(plan, "1:1")

    expect(layout(moveSlots(plan, keys, plan.groups[1]!.id, null), sources)).toEqual([
      "1:2",
      "2:1",
      "1:1",
    ])
    expect(moveSlots(plan, keys, plan.groups[0]!.id, [...keys][0]!)).toBe(plan)
  })

  test("keeps an emptied group, which contributes no pages", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 1))
    const emptied = deleteSlots(plan, keysOf(plan, "1:1"))

    expect(emptied.groups).toHaveLength(2)
    expect(layout(emptied, sources)).toEqual(["2:1"])
  })

  test("turns pages and trades a blank's sides", () => {
    const { plan, sources } = setup(source(1, 1))
    const withBlank = insertBlank(plan, sources, plan.groups[0]!.id, 1)
    const keys = new Set(withBlank.groups[0]!.slots.map((slot) => slot.key))
    const turned = rotateSlots(rotateSlots(withBlank, keys, 90), keys, 90)
    const [page, blank] = rotateSlots(withBlank, keys, 270).groups[0]!.slots

    expect(turned.groups[0]!.slots[0]).toMatchObject({ turn: 180 })
    expect(page).toMatchObject({ turn: 270 })
    expect(blank).toMatchObject({ height: 200, width: 300 })
  })

  test("sizes a blank like its neighbour, or as A4 when fitting", () => {
    const { plan, sources } = setup(source(1, 1))
    const group = plan.groups[0]!.id

    expect(insertBlank(plan, sources, group, 0).groups[0]!.slots[0]).toMatchObject({
      height: 300,
      kind: "blank",
      width: 200,
    })
    expect(
      insertBlank(setOptions(plan, { normalizeA4: true }), sources, group, 0).groups[0]!
        .slots[0],
    ).toMatchObject({ height: 841.89, width: 595.28 })
  })

  test("hands back the plan itself for an edit that changes nothing", () => {
    const { plan } = setup(source(1, 2), source(2, 1))
    const gone = new Set([999])
    const [first, second] = plan.groups[0]!.slots

    expect(deleteSlots(plan, gone)).toBe(plan)
    expect(rotateSlots(plan, gone, 90)).toBe(plan)
    expect(moveSlots(plan, gone, plan.groups[1]!.id, null)).toBe(plan)
    expect(moveSlots(plan, new Set([first!.key]), plan.groups[0]!.id, second!.key)).toBe(plan)
    expect(removeGroups(plan, gone)).toBe(plan)
    expect(setOptions(plan, { smartPadding: false })).toBe(plan)
  })

  test("reorders and removes whole files", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 1), source(3, 1))

    expect(layout(moveGroup(plan, 2, 0), sources)).toEqual(["3:1", "1:1", "2:1"])
    expect(
      layout(removeGroups(plan, new Set([plan.groups[1]!.id])), sources),
    ).toEqual(["1:1", "3:1"])
  })
})

describe("outputPages", () => {
  test("pads a file that would otherwise start on an even page", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 2), source(3, 1))
    const padded = setOptions(plan, { smartPadding: true })

    expect(layout(padded, sources)).toEqual(["1:1", "pad", "2:1", "2:2", "3:1"])
  })

  test("sizes the padding like the page it precedes, turned as it stands", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 1))
    const second = plan.groups[1]!
    const turned = rotateSlots(
      setOptions(plan, { smartPadding: true }),
      new Set([second.slots[0]!.key]),
      90,
    )

    expect(outputPages(turned, sources)[1]).toMatchObject({
      height: 200,
      kind: "padding",
      width: 300,
    })
  })

  test("lays padding on the A4 sheet the engine fits the next page to", () => {
    // 500x400 fits upright A4 unshrunk, so the engine keeps that sheet upright
    // and turns it with the page — the padding must match either way.
    const wide = { ...source(2, 1), pages: [{ height: 400, rotation: 0, width: 500 }] }
    const { plan, sources } = setup(source(1, 1), wide)
    const fitted = setOptions(plan, { normalizeA4: true, smartPadding: true })
    const turned = rotateSlots(fitted, new Set([fitted.groups[1]!.slots[0]!.key]), 90)

    expect(outputPages(fitted, sources)[1]).toMatchObject({ height: 841.89, width: 595.28 })
    expect(outputPages(turned, sources)[1]).toMatchObject({ height: 595.28, width: 841.89 })
  })

  test("hands the engine every slot and padding page", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 1))
    const padded = setOptions(plan, { smartPadding: true })

    expect(assembleSlots(outputPages(padded, sources), false)).toEqual([
      { kind: "page", pageNumber: 1, sourceId: 1, turn: 0 },
      { height: 300, kind: "blank", width: 200 },
      { kind: "page", pageNumber: 1, sourceId: 2, turn: 0 },
    ])
  })
})

describe("organizeOutline", () => {
  const chapters = [
    {
      items: [{ items: [], pageNumber: 3, title: "Section" }],
      pageNumber: 2,
      title: "Chapter",
    },
  ]

  test("gives each file a bookmark at its first page", () => {
    const { plan, sources } = setup(source(1, 2), source(2, 1))

    expect(organizeOutline(plan, sources)).toEqual([
      { items: [], pageNumber: 1, title: "file-1" },
      { items: [], pageNumber: 3, title: "file-2" },
    ])
  })

  test("nests a file's own bookmarks, following pages moved to another file", () => {
    const { plan, sources } = setup(source(1, 3, chapters), source(2, 1))
    const both = setOptions(plan, { keepBookmarks: true })
    const moved = moveSlots(both, keysOf(both, "1:3"), both.groups[1]!.id, null)

    expect(organizeOutline(moved, sources)).toEqual([
      {
        items: [
          {
            items: [{ items: [], pageNumber: 4, title: "Section" }],
            pageNumber: 2,
            title: "Chapter",
          },
        ],
        pageNumber: 1,
        title: "file-1",
      },
      { items: [], pageNumber: 3, title: "file-2" },
    ])
  })

  test("drops a bookmark whose page is gone, keeping its children", () => {
    const { plan, sources } = setup(source(1, 3, chapters))
    const kept = setOptions(plan, { fileBookmarks: false, keepBookmarks: true })

    expect(organizeOutline(deleteSlots(kept, keysOf(kept, "1:2")), sources)).toEqual([
      { items: [], pageNumber: 2, title: "Section" },
    ])
  })

  test("raises a removed file's bookmarks to the top where its pages now stand", () => {
    const { plan, sources } = setup(source(1, 3, chapters), source(2, 1))
    const both = setOptions(plan, { keepBookmarks: true })
    const moved = moveSlots(both, keysOf(both, "1:2", "1:3"), both.groups[1]!.id, null)
    const removed = removeGroups(moved, new Set([moved.groups[0]!.id]))

    expect(organizeOutline(removed, sources)).toEqual([
      { items: [], pageNumber: 1, title: "file-2" },
      {
        items: [{ items: [], pageNumber: 3, title: "Section" }],
        pageNumber: 2,
        title: "Chapter",
      },
    ])
  })

  test("writes none when neither kind is asked for", () => {
    const { plan, sources } = setup(source(1, 3, chapters))

    expect(organizeOutline(setOptions(plan, { fileBookmarks: false }), sources)).toEqual([])
  })
})
