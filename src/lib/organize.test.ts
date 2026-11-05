import { describe, expect, test } from "bun:test"

import {
  addSources,
  assembleSlots,
  copySlots,
  deleteSlots,
  emptyPlan,
  fileBookmarks,
  groupGap,
  groupSlotKeys,
  insertBlank,
  moveGroups,
  moveSlots,
  organizeOutline,
  outputPages,
  removeGroups,
  renameGroup,
  restartPlan,
  rotateSlots,
  setOptions,
  slotGap,
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

  test("copies pages in plan order under new keys, leaving the originals", () => {
    const { plan, sources } = setup(source(1, 3), source(2, 1))
    const copied = copySlots(plan, keysOf(plan, "1:3", "1:1"), plan.groups[1]!.id, 0)
    const keys = copied.groups.flatMap((group) => group.slots.map((slot) => slot.key))

    expect(layout(copied, sources)).toEqual(["1:1", "1:2", "1:3", "1:1", "1:3", "2:1"])
    expect(new Set(keys).size).toBe(keys.length)
    expect(copied.nextKey).toBe(plan.nextKey + 2)
    expect(copySlots(plan, new Set([999]), plan.groups[0]!.id, 0)).toBe(plan)
  })

  test("finds the gap beside the chosen pages, or the last file's end", () => {
    const { plan } = setup(source(1, 3), source(2, 2))
    const [first, second] = plan.groups

    expect(slotGap(plan, keysOf(plan, "2:1", "1:2"), "before")).toEqual({
      group: first!,
      index: 1,
    })
    expect(slotGap(plan, keysOf(plan, "2:1", "1:2"), "after")).toEqual({
      group: second!,
      index: 1,
    })
    expect(slotGap(plan, new Set(), "before")).toEqual({ group: second!, index: 2 })
    expect(slotGap(emptyPlan, new Set(), "after")).toBeNull()
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
    const [first, second, third] = plan.groups.map((group) => group.id)

    expect(layout(moveGroups(plan, new Set([third!]), 0), sources)).toEqual([
      "3:1",
      "1:1",
      "2:1",
    ])
    expect(
      layout(removeGroups(plan, new Set([plan.groups[1]!.id])), sources),
    ).toEqual(["1:1", "3:1"])
    expect(layout(moveGroups(plan, new Set([first!, third!]), 1), sources)).toEqual([
      "2:1",
      "1:1",
      "3:1",
    ])
    expect(moveGroups(plan, new Set([first!, second!]), 0)).toBe(plan)
    expect(moveGroups(plan, new Set([999]), 0)).toBe(plan)
  })

  test("finds the pages and the edges of the chosen files", () => {
    const { plan } = setup(source(1, 2), source(2, 1), source(3, 1))
    const emptied = deleteSlots(plan, new Set(plan.groups[2]!.slots.map((slot) => slot.key)))
    const [first, , third] = emptied.groups
    const chosen = new Set([first!.id, third!.id])

    expect([...groupSlotKeys(emptied, chosen)]).toEqual(first!.slots.map((slot) => slot.key))
    expect(groupGap(emptied, chosen, "before")).toEqual({ group: first!, index: 0 })
    expect(groupGap(emptied, chosen, "after")).toEqual({ group: third!, index: 0 })
    expect(groupGap(emptied, new Set(), "after")).toBeNull()
  })

  test("starts over with new files, keeping the options and numbering on", () => {
    const { plan } = setup(source(1, 2))
    const fitted = setOptions(plan, { normalizeA4: true })
    const restarted = restartPlan(fitted, [source(2, 1), source(3, 1)])
    const sources = new Map([source(2, 1), source(3, 1)].map((item) => [item.id, item]))
    const oldKeys = new Set(
      fitted.groups.flatMap((group) => [group.id, ...group.slots.map((slot) => slot.key)]),
    )

    expect(layout(restarted, sources)).toEqual(["2:1", "3:1"])
    expect(restarted.options.normalizeA4).toBe(true)
    expect(
      restarted.groups
        .flatMap((group) => [group.id, ...group.slots.map((slot) => slot.key)])
        .some((key) => oldKeys.has(key)),
    ).toBe(false)
    expect(restartPlan(fitted, []).groups).toEqual([])
  })
})

describe("outputPages", () => {
  test("pads a file that would otherwise start on an even page", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 2), source(3, 1))
    const padded = setOptions(plan, { smartPadding: true })

    expect(layout(padded, sources)).toEqual(["1:1", "pad", "2:1", "2:2", "3:1"])
  })

  test("closes the file before, sized like its last page as it stands", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 1))
    const first = plan.groups[0]!
    const turned = rotateSlots(
      setOptions(plan, { smartPadding: true }),
      new Set([first.slots[0]!.key]),
      90,
    )

    expect(outputPages(turned, sources)[1]).toMatchObject({
      groupId: first.id,
      height: 200,
      kind: "padding",
      width: 300,
    })
  })

  test("lays padding on the A4 sheet the engine fits the last page to", () => {
    // 500x400 fits upright A4 unshrunk, so the engine keeps that sheet upright
    // and turns it with the page — the padding must match either way.
    const wide = { ...source(1, 1), pages: [{ height: 400, rotation: 0, width: 500 }] }
    const { plan, sources } = setup(wide, source(2, 1))
    const fitted = setOptions(plan, { normalizeA4: true, smartPadding: true })
    const turned = rotateSlots(fitted, new Set([fitted.groups[0]!.slots[0]!.key]), 90)

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
    const moved = moveSlots(plan, keysOf(plan, "1:3"), plan.groups[1]!.id, null)

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

    expect(organizeOutline(deleteSlots(plan, keysOf(plan, "1:2")), sources)).toEqual([
      {
        items: [{ items: [], pageNumber: 2, title: "Section" }],
        pageNumber: 1,
        title: "file-1",
      },
    ])
  })

  test("hangs a removed file's bookmarks under the file now holding their pages", () => {
    const { plan, sources } = setup(source(1, 3, chapters), source(2, 1))
    const moved = moveSlots(plan, keysOf(plan, "1:2", "1:3"), plan.groups[1]!.id, null)
    const removed = removeGroups(moved, new Set([moved.groups[0]!.id]))

    expect(organizeOutline(removed, sources)).toEqual([
      {
        items: [
          {
            items: [{ items: [], pageNumber: 3, title: "Section" }],
            pageNumber: 2,
            title: "Chapter",
          },
        ],
        pageNumber: 1,
        title: "file-2",
      },
    ])
  })

  test("places a removed file's bookmarks by page among the new file's own", () => {
    const { plan, sources } = setup(
      source(1, 1, [{ items: [], pageNumber: 1, title: "Moved" }]),
      source(2, 2, [{ items: [], pageNumber: 2, title: "Own" }]),
    )
    const [first, second] = plan.groups
    const before = [...keysOf(plan, "2:2")][0]!
    const moved = moveSlots(plan, keysOf(plan, "1:1"), second!.id, before)
    const removed = removeGroups(moved, new Set([first!.id]))

    expect(organizeOutline(removed, sources)[0]?.items).toEqual([
      { items: [], pageNumber: 2, title: "Moved" },
      { items: [], pageNumber: 3, title: "Own" },
    ])
  })

  test("lists a file left without pages, which the new PDF gets no bookmark for", () => {
    const { plan, sources } = setup(source(1, 3, chapters), source(2, 1))
    const [first, second] = plan.groups
    const moved = moveSlots(plan, keysOf(plan, "1:1", "1:2", "1:3"), second!.id, null)
    const bookmarks = fileBookmarks(moved, sources)

    expect(bookmarks.get(first!.id)).toEqual({ items: [], pageNumber: undefined, title: "file-1" })
    expect(bookmarks.get(second!.id)?.items.map((item) => item.title)).toEqual(["Chapter"])
    expect(organizeOutline(moved, sources).map((item) => item.title)).toEqual(["file-2"])
  })

  test("keeps a copied page's bookmarks on the first of its copies", () => {
    const { plan, sources } = setup(source(1, 3, chapters), source(2, 1))
    const copied = copySlots(plan, keysOf(plan, "1:2"), plan.groups[1]!.id, 1)

    expect(fileBookmarks(copied, sources).get(plan.groups[0]!.id)?.items[0]?.pageNumber).toBe(2)
  })

  test("writes none once cleared, whatever the files carry", () => {
    const { plan, sources } = setup(source(1, 3, chapters))

    expect(organizeOutline(setOptions(plan, { bookmarks: false }), sources)).toEqual([])
  })
})

describe("renameGroup", () => {
  test("retitles the file's bookmark and keeps the history step to a real change", () => {
    const { plan, sources } = setup(source(1, 1), source(2, 1))
    const groupId = plan.groups[0]!.id
    const renamed = renameGroup(plan, groupId, "  Introduction ")

    expect(organizeOutline(renamed, sources).map((item) => item.title)).toEqual([
      "Introduction",
      "file-2",
    ])
    expect(renameGroup(renamed, groupId, "Introduction")).toBe(renamed)
    expect(renameGroup(renamed, groupId, "   ")).toBe(renamed)
    expect(renameGroup(renamed, -1, "Elsewhere")).toBe(renamed)
  })
})
