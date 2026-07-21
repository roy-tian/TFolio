import { describe, expect, it } from "bun:test"

import {
  canRedo,
  canUndo,
  commandPages,
  commandTextPages,
  commit,
  emptyHistory,
  fillMergeOutcome,
  historyHead,
  inversePermutation,
  isDirty,
  markSaved,
  mergeFilePages,
  movesPages,
  planDeletePages,
  planInsertBlankPage,
  planMergeFile,
  planReorderPages,
  planWatermarkChange,
  redo,
  undo,
  watermarkConfig,
  type AnnotationCommand,
  type AnnotationHistory,
} from "@/lib/annotations"
import { defaultWatermarkConfig, type WatermarkConfig } from "@/lib/watermark"

function highlight(...pageNumbers: number[]): AnnotationCommand {
  return {
    color: "#ffd54a",
    kind: "highlight",
    opacity: 0.4,
    targets: pageNumbers.map((pageNumber) => ({
      pageNumber,
      quads: [{ height: 10, left: 0, top: 0, width: 50 }],
    })),
  }
}

/** Applies each command in turn, as a reader drawing them one after another. */
function historyOf(...commands: AnnotationCommand[]): AnnotationHistory {
  return commands.reduce(commit, emptyHistory)
}

function watermark(
  config: WatermarkConfig | null,
  previous: WatermarkConfig | null = null,
): AnnotationCommand {
  return { config, kind: "watermark", pageCount: 3, previous }
}

describe("commandPages", () => {
  it("reports the page a single-page command writes to", () => {
    expect(commandPages(highlight(3))).toEqual([3])
  })

  // A selection dragged across a page break is one action, so its command
  // carries every page it touched and an undo has to take all of them back.
  it("reports every page a selection ran across", () => {
    expect(commandPages(highlight(3, 4))).toEqual([3, 4])
  })

  it("reports every page a document watermark changes", () => {
    expect(commandPages(watermark(defaultWatermarkConfig()))).toEqual([1, 2, 3])
  })

  it("invalidates extracted text only for page-content watermarks", () => {
    expect(commandTextPages(highlight(2))).toEqual([])
    expect(commandTextPages(watermark(defaultWatermarkConfig()))).toEqual([
      1, 2, 3,
    ])
  })
})

describe("watermarkConfig", () => {
  const first = { ...defaultWatermarkConfig(), text: "DRAFT" }
  const second = { ...defaultWatermarkConfig(), text: "FINAL" }

  it("tracks apply, replace, explicit remove, undo, and redo", () => {
    const applied = historyOf(watermark(first))
    const replaced = commit(applied, watermark(second, first))
    const removed = commit(replaced, watermark(null, second))

    expect(watermarkConfig(applied)).toEqual(first)
    expect(watermarkConfig(replaced)).toEqual(second)
    expect(watermarkConfig(removed)).toBeNull()
    expect(watermarkConfig(undo(removed)!.history)).toEqual(second)
    expect(watermarkConfig(redo(undo(removed)!.history)!.history)).toBeNull()
  })

  it("keeps an explicit remove authoritative over older configurations", () => {
    const removed = historyOf(watermark(first), watermark(null, first), highlight(1))

    expect(watermarkConfig(removed)).toBeNull()
  })

  it("follows the new branch after undo", () => {
    const replaced = historyOf(watermark(first), watermark(second, first))
    const branched = commit(undo(replaced)!.history, watermark(null, first))

    expect(watermarkConfig(branched)).toBeNull()
    expect(canRedo(branched)).toBe(false)
  })

  it("plans previous from the queue's current history and skips a no-op", () => {
    const queued = historyOf(watermark(first), highlight(2))
    const planned = planWatermarkChange(queued, second, 3)!

    expect(planned.command.previous).toEqual(first)
    expect(watermarkConfig(planned.history)).toEqual(second)
    expect(planWatermarkChange(planned.history, second, 3)).toBeNull()
  })
})

describe("commit", () => {
  it("applies a command", () => {
    const history = historyOf(highlight(1))

    expect(history.past).toHaveLength(1)
    expect(canUndo(history)).toBe(true)
    expect(canRedo(history)).toBe(false)
  })

  it("gives each command its own identity", () => {
    const history = historyOf(highlight(1), highlight(1))

    expect(history.past[0]!.id).not.toBe(history.past[1]!.id)
  })

  // Drawing after an undo takes a new branch; the old one is gone for good and
  // must not be reachable by pressing redo.
  it("drops anything undone", () => {
    const undone = undo(historyOf(highlight(1)))!.history

    expect(canRedo(undone)).toBe(true)
    expect(canRedo(commit(undone, highlight(2)))).toBe(false)
  })
})

describe("undo and redo", () => {
  it("reports nothing to undo on an untouched document", () => {
    expect(undo(emptyHistory)).toBeNull()
    expect(canUndo(emptyHistory)).toBe(false)
  })

  it("reports nothing to redo until something is undone", () => {
    expect(redo(historyOf(highlight(1)))).toBeNull()
  })

  it("takes back the most recent command first", () => {
    const history = historyOf(highlight(1), highlight(2))
    const undone = undo(history)!

    expect(commandPages(undone.entry.command)).toEqual([2])
    expect(undone.history.past).toHaveLength(1)
  })

  it("re-applies the most recently undone command", () => {
    const undone = undo(historyOf(highlight(1), highlight(2)))!
    const redone = redo(undone.history)!

    expect(commandPages(redone.entry.command)).toEqual([2])
    expect(redone.history.past).toHaveLength(2)
  })

  // Redoing re-runs the command and gets a fresh annotation out of PDFium, but
  // it is still the same entry in the reader's history.
  it("keeps an entry's identity across an undo and redo", () => {
    const history = historyOf(highlight(1))
    const id = historyHead(history)
    const restored = redo(undo(history)!.history)!

    expect(restored.entry.id).toBe(id)
    expect(historyHead(restored.history)).toBe(id)
  })

  it("winds a whole document back and forward again", () => {
    const history = historyOf(highlight(1), highlight(2), highlight(3))
    let wound = history

    for (let step = 0; step < 3; step += 1) {
      wound = undo(wound)!.history
    }

    expect(canUndo(wound)).toBe(false)
    expect(wound.past).toHaveLength(0)

    for (let step = 0; step < 3; step += 1) {
      wound = redo(wound)!.history
    }

    expect(canRedo(wound)).toBe(false)
    expect(wound.past.map((entry) => entry.id)).toEqual(
      history.past.map((entry) => entry.id),
    )
  })
})

describe("isDirty", () => {
  it("reports a freshly opened document clean", () => {
    expect(isDirty(emptyHistory)).toBe(false)
  })

  it("reports a drawn-on document dirty", () => {
    expect(isDirty(historyOf(highlight(1)))).toBe(true)
  })

  it("reports a saved document clean", () => {
    expect(isDirty(markSaved(historyOf(highlight(1))))).toBe(false)
  })

  it("reports a document drawn on after a save dirty", () => {
    const saved = markSaved(historyOf(highlight(1)))

    expect(isDirty(commit(saved, highlight(2)))).toBe(true)
  })

  // Undoing past a save leaves the document holding less than the file does,
  // which is still a difference the reader may want to write out.
  it("reports a document undone past its save dirty", () => {
    const saved = markSaved(historyOf(highlight(1)))

    expect(isDirty(undo(saved)!.history)).toBe(true)
  })

  // The case a plain edit counter gets wrong: winding back to exactly what was
  // saved leaves the document matching the file, so there is nothing to write.
  it("reports a document undone back to its save clean", () => {
    const saved = markSaved(historyOf(highlight(1)))
    const drawn = commit(saved, highlight(2))

    expect(isDirty(undo(drawn)!.history)).toBe(false)
  })

  it("reports a document redone back to its save clean", () => {
    const history = markSaved(historyOf(highlight(1), highlight(2)))
    const wound = redo(undo(history)!.history)!.history

    expect(isDirty(wound)).toBe(false)
  })
})

describe("movesPages", () => {
  it("is true only for the four structure commands", () => {
    const reorder: AnnotationCommand = { inverse: [2, 1], kind: "reorderPages", order: [2, 1] }
    const del: AnnotationCommand = { kind: "deletePages", pageCount: 3, pages: [2], stashId: 1 }
    const insert: AnnotationCommand = { index: 2, kind: "insertBlankPage", pageCount: 3, stashId: 1 }
    const merge: AnnotationCommand = {
      insertedAt: 0,
      kind: "mergeFile",
      name: "b.pdf",
      pageCount: 0,
      path: "/b.pdf",
      stashId: 1,
    }

    for (const command of [reorder, del, insert, merge]) {
      expect(movesPages(command)).toBe(true)
    }

    // An annotation or watermark leaves every page where it was, so undoing one
    // must not discard a note the reader is still typing.
    for (const command of [highlight(1), watermark(null)]) {
      expect(movesPages(command)).toBe(false)
    }
  })
})

describe("structure commands", () => {
  it("derives the inverse permutation", () => {
    expect(inversePermutation([3, 1, 4, 2])).toEqual([2, 4, 1, 3])
    expect(inversePermutation([1, 2, 3])).toEqual([1, 2, 3])
  })

  it("undoes any order through its inverse", () => {
    const order = [5, 3, 1, 2, 4]
    const inverse = inversePermutation(order)

    // Composed either way round, a permutation and its inverse cancel out.
    expect(inverse.map((pageNumber) => order[pageNumber - 1])).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(order.map((pageNumber) => inverse[pageNumber - 1])).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  it("does not spend an undo step on the identity order", () => {
    expect(planReorderPages(emptyHistory, [1, 2, 3])).toBeNull()

    const planned = planReorderPages(emptyHistory, [2, 1])

    expect(planned).not.toBeNull()
    expect(planned!.command).toEqual({
      inverse: [2, 1],
      kind: "reorderPages",
      order: [2, 1],
    })
    expect(planned!.history.past).toHaveLength(1)
  })

  it("hands the delete its own entry id as the stash id", () => {
    const history = historyOf(highlight(1))
    const planned = planDeletePages(history, [3, 2], 4)

    expect(planned!.command).toEqual({
      kind: "deletePages",
      pageCount: 4,
      pages: [2, 3],
      stashId: history.nextId,
    })
    expect(planned!.history.past.at(-1)!.id).toBe(planned!.command.stashId)
  })

  it("refuses a deletion that empties or misses the document", () => {
    expect(planDeletePages(emptyHistory, [], 4)).toBeNull()
    expect(planDeletePages(emptyHistory, [1, 2, 3, 4], 4)).toBeNull()
    // Duplicates collapse before the leave-one-page rule is judged.
    expect(planDeletePages(emptyHistory, [1, 1], 2)).not.toBeNull()
  })

  it("plans an insert whose undo shares the entry id", () => {
    const planned = planInsertBlankPage(emptyHistory, 3, 4)

    expect(planned!.command).toEqual({
      index: 3,
      kind: "insertBlankPage",
      pageCount: 5,
      stashId: emptyHistory.nextId,
    })
    expect(planInsertBlankPage(emptyHistory, 0, 4)).toBeNull()
    expect(planInsertBlankPage(emptyHistory, 6, 4)).toBeNull()
  })

  it("invalidates every page, bitmaps and text alike", () => {
    const reorder = planReorderPages(emptyHistory, [2, 1, 3])!.command
    const deletion = planDeletePages(emptyHistory, [2], 3)!.command
    const insertion = planInsertBlankPage(emptyHistory, 1, 3)!.command

    expect(commandPages(reorder)).toEqual([1, 2, 3])
    expect(commandTextPages(reorder)).toEqual([1, 2, 3])
    // Delete invalidates the wider, pre-delete shape of the document.
    expect(commandPages(deletion)).toEqual([1, 2, 3])
    // Insert invalidates the wider, post-insert shape.
    expect(commandPages(insertion)).toEqual([1, 2, 3, 4])
    expect(commandTextPages(insertion)).toEqual([1, 2, 3, 4])
  })

  it("marks a pad insert and leaves a plain one unflagged", () => {
    expect(planInsertBlankPage(emptyHistory, 2, 3, true)!.command).toEqual({
      index: 2,
      kind: "insertBlankPage",
      pad: true,
      pageCount: 4,
      stashId: emptyHistory.nextId,
    })
    // A plain insert carries no pad key at all, so it is byte-identical to what
    // the page-editing grid produced before parity padding existed.
    expect(
      "pad" in planInsertBlankPage(emptyHistory, 2, 3)!.command,
    ).toBe(false)
  })
})

describe("merge commands", () => {
  it("plans a merge with its counts unknown until the file is read", () => {
    const history = historyOf(highlight(1))
    const planned = planMergeFile(history, "/b.pdf", "b.pdf")

    expect(planned.command).toEqual({
      insertedAt: 0,
      kind: "mergeFile",
      name: "b.pdf",
      pageCount: 0,
      path: "/b.pdf",
      stashId: history.nextId,
    })
    // The stash rides the entry id, so the undo's delete and its redo's restore
    // pair up exactly, as every structure command's do.
    expect(planned.history.past.at(-1)!.id).toBe(planned.command.stashId)
  })

  it("a merge never invalidates an existing page's pixels or text", () => {
    const command = planMergeFile(emptyHistory, "/b.pdf", "b.pdf").command

    expect(commandPages(command)).toEqual([])
    expect(commandTextPages(command)).toEqual([])
  })

  it("fills the position and page count the first apply learned", () => {
    const planned = planMergeFile(historyOf(highlight(1)), "/b.pdf", "b.pdf")
    const id = planned.history.past.at(-1)!.id
    const filled = fillMergeOutcome(planned.history, id, 3, 4)
    const command = filled.past.at(-1)!.command

    expect(command).toMatchObject({ insertedAt: 3, pageCount: 4 })
    // The delete an undo runs, and the restore a redo runs, cover the appended
    // range — pages 3 through 6.
    expect(mergeFilePages(command as never)).toEqual([3, 4, 5, 6])
  })
})
