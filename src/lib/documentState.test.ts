import { describe, expect, it } from "bun:test"

import {
  commit,
  emptyHistory,
  planDeletePages,
  planDuplicatePages,
  planEraseAnnotation,
  planInsertBlankPage,
  planInsertFiles,
  planPageNumbersChange,
  planRenameSection,
  planReorderPages,
  planRotatePages,
  planWatermarkChange,
  redo,
  undo,
  type AnnotationCommand,
  type AnnotationHistory,
} from "@/lib/annotations"
import { defaultRectStyle } from "@/lib/annotationStyles"
import { documentState, isDirty, markSaved } from "@/lib/documentState"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import { defaultWatermarkConfig } from "@/lib/watermark"

type Step = (history: AnnotationHistory) => { history: AnnotationHistory } | null

function after(history: AnnotationHistory, ...steps: Step[]) {
  return steps.reduce((current, step) => step(current)!.history, history)
}

const turn = (pages: number[], degrees: number): Step => (history) =>
  planRotatePages(history, pages, degrees)
const reorder = (...order: number[]): Step => (history) => planReorderPages(history, order)
const remove = (pages: number[], pageCount: number): Step => (history) =>
  planDeletePages(history, pages, pageCount)
const blank = (index: number, pageCount: number): Step => (history) =>
  planInsertBlankPage(history, index, pageCount)
const back: Step = (history) => undo(history)
const forward: Step = (history) => redo(history)

const rect: AnnotationCommand = {
  bounds: { height: 20, left: 10, top: 10, width: 40 },
  kind: "rect",
  pageNumber: 1,
  style: defaultRectStyle,
}

describe("isDirty, judged by what a save would write", () => {
  it("reports a page turned all the way round clean", () => {
    expect(isDirty(after(emptyHistory, turn([2], 90), turn([2], 90), turn([2], 90)))).toBe(true)
    expect(
      isDirty(after(emptyHistory, turn([2], 90), turn([2], 90), turn([2], 90), turn([2], 90))),
    ).toBe(false)
    expect(isDirty(after(emptyHistory, turn([1, 2], 90), turn([1, 2], 270)))).toBe(false)
  })

  it("reports pages turned by different amounts dirty", () => {
    expect(isDirty(after(emptyHistory, turn([1, 2], 90), turn([1], 270)))).toBe(true)
  })

  // The turn belongs to the page, wherever a reorder has taken it.
  it("follows a turned page through a reorder", () => {
    const moved = after(emptyHistory, turn([1], 90), reorder(2, 1, 3), turn([2], 270))

    expect(isDirty(moved)).toBe(true)
    expect(isDirty(after(moved, reorder(2, 1, 3)))).toBe(false)
  })

  it("reports a blank page inserted and deleted again clean", () => {
    expect(isDirty(after(emptyHistory, blank(2, 3)))).toBe(true)
    expect(isDirty(after(emptyHistory, blank(2, 3), remove([2], 4)))).toBe(false)
  })

  // Another blank page is not the page the file holds: its size, hidden
  // fields and the bookmarks aimed at it are all the old page's.
  it("reports a page deleted and a blank inserted in its place dirty", () => {
    expect(isDirty(after(emptyHistory, remove([2], 3), blank(2, 2)))).toBe(true)
  })

  it("tells a page from its copy", () => {
    const copied = after(emptyHistory, (history) => planDuplicatePages(history, [1], 2, 3))

    expect(isDirty(after(copied, remove([2], 4)))).toBe(false)
    expect(isDirty(after(copied, remove([1], 4)))).toBe(true)
  })

  it("reports pages moved and moved back clean", () => {
    expect(isDirty(after(emptyHistory, reorder(3, 1, 2), reorder(2, 3, 1)))).toBe(false)
    expect(isDirty(after(emptyHistory, reorder(3, 1, 2)))).toBe(true)
  })

  it("reports a mark drawn and erased again clean", () => {
    const drawn = commit(emptyHistory, rect)
    const erased = planEraseAnnotation(drawn, drawn.past[0]!.id)!.history

    expect(isDirty(drawn)).toBe(true)
    expect(isDirty(erased)).toBe(false)
  })

  it("reports a watermark added and removed clean", () => {
    const removed = after(
      emptyHistory,
      (history) => planWatermarkChange(history, defaultWatermarkConfig("draft"), 3),
      (history) => planWatermarkChange(history, null, 3),
    )

    expect(isDirty(removed)).toBe(false)
  })

  // The engine draws a layer to the pages as they stand and never redraws it
  // when they move, so a layer laid again over other pages is other content.
  it("reports a layer laid again over moved or turned pages dirty", () => {
    const numbers: PageNumbersConfig = {
      blankCounted: true,
      blankNumbered: false,
      mode: "single",
      position: "bottomCenter",
      range: null,
      smartColor: false,
      start: null,
    }
    const saved = markSaved(
      after(emptyHistory, (history) => planPageNumbersChange(history, numbers, 3)),
    )
    const relaid = (...steps: Step[]) =>
      after(
        saved,
        ...steps.slice(0, 1),
        (history) => planPageNumbersChange(history, null, 3),
        (history) => planPageNumbersChange(history, numbers, 3),
        ...steps.slice(1),
      )

    expect(isDirty(relaid(reorder(2, 1, 3), reorder(2, 1, 3)))).toBe(true)
    expect(isDirty(relaid(turn([1], 90), turn([1], 270)))).toBe(true)
    expect(isDirty(after(saved, reorder(2, 1, 3), reorder(2, 1, 3)))).toBe(false)
  })

  it("reports a file renamed and named back clean", () => {
    const renamed = after(emptyHistory, (history) =>
      planRenameSection(history, 1, "Report", "Draft"),
    )

    expect(isDirty(renamed)).toBe(true)
    expect(
      isDirty(after(renamed, (history) => planRenameSection(history, 1, "Draft", "Report"))),
    ).toBe(false)
  })

  // Runs, padding and file bookmarks are the engine's, so a document that took
  // files is never judged unchanged by its pages alone.
  it("keeps added files dirty even once their pages are deleted", () => {
    const added = after(
      emptyHistory,
      (history) => planInsertFiles(history, ["other.pdf"], 2, 4, 3),
      remove([4, 5], 5),
    )

    expect(isDirty(added)).toBe(true)
  })

  it("compares with what was saved, not with the file as opened", () => {
    const saved = markSaved(after(emptyHistory, turn([1], 90)))

    expect(isDirty(after(saved, turn([1], 270)))).toBe(true)
    expect(isDirty(after(saved, turn([1], 270), turn([1], 90)))).toBe(false)
  })

  // The saved entry is gone for good, yet the state it saved is reached again.
  it("reports a document undone past its save and turned back to it clean", () => {
    const saved = markSaved(after(emptyHistory, turn([1], 90)))

    expect(isDirty(after(saved, back))).toBe(true)
    expect(isDirty(after(saved, back, turn([1], 90)))).toBe(false)
  })

  // A redo restores the page its undo stashed, so it is the saved one.
  it("takes a redone insert's page for the one the save held", () => {
    const saved = markSaved(after(emptyHistory, blank(2, 3)))

    expect(isDirty(after(saved, back, forward, turn([2], 180), turn([2], 180)))).toBe(false)
  })

  it("answers by the head alone without the saved state", () => {
    const saved = markSaved(after(emptyHistory, turn([1], 90)))
    const moved = { ...saved, saved: null }

    expect(isDirty(moved)).toBe(false)
    expect(isDirty(after(moved, turn([1], 180), turn([1], 180)))).toBe(true)
  })
})

describe("documentState", () => {
  it("stays plain data, so a moved tab's history can carry it", () => {
    const state = documentState(after(emptyHistory, blank(1, 2), turn([1], 90)).past)

    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })
})
