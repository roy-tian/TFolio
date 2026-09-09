import { describe, expect, it } from "bun:test"

import {
  canRedo,
  canUndo,
  commandPages,
  commandTextPages,
  commit,
  emptyHistory,
  fillErasedPages,
  fillInsertFileOutcome,
  historyHead,
  inversePermutation,
  isDirty,
  markSaved,
  insertFilePages,
  insertPagesRange,
  movesPages,
  nextRedoCommand,
  nextUndoCommand,
  pageNumbersConfig,
  planDeletePages,
  planDuplicatePages,
  planEraseAnnotation,
  planInsertBlankPage,
  planInsertFile,
  planInsertPages,
  planPageNumbersChange,
  planReorderPages,
  planRotatePages,
  planWatermarkChange,
  redo,
  retargetCommand,
  undo,
  watermarkConfig,
  type AnnotationCommand,
  type AnnotationHistory,
} from "@/lib/annotations"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
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

function pageNumbersConfigValue(
  overrides: Partial<PageNumbersConfig> = {},
): PageNumbersConfig {
  return {
    mode: "single",
    position: "bottomCenter",
    range: null,
    smartColor: true,
    start: null,
    blankNumbered: true,
    blankCounted: true,
    ...overrides,
  }
}

function pageNumbers(
  config: PageNumbersConfig | null,
  previous: PageNumbersConfig | null = null,
): AnnotationCommand {
  return { config, kind: "pageNumbers", pageCount: 3, previous }
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
    expect(commandPages(watermark(defaultWatermarkConfig("DRAFT")))).toEqual([1, 2, 3])
  })

  it("reports every page a page-number change covers", () => {
    expect(commandPages(pageNumbers(pageNumbersConfigValue()))).toEqual([
      1, 2, 3,
    ])
  })

  it("invalidates extracted text only for page-content watermarks", () => {
    expect(commandTextPages(highlight(2))).toEqual([])
    expect(commandTextPages(pageNumbers(pageNumbersConfigValue()))).toEqual([
      1, 2, 3,
    ])
    expect(commandTextPages(watermark(defaultWatermarkConfig("DRAFT")))).toEqual([
      1, 2, 3,
    ])
  })
})

describe("watermarkConfig", () => {
  const first = defaultWatermarkConfig("DRAFT")
  const second = defaultWatermarkConfig("FINAL")

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

describe("pageNumbersConfig", () => {
  const first = pageNumbersConfigValue({ position: "bottomRight" })
  const second = pageNumbersConfigValue({ mode: "duplex", range: [2, 3] })

  it("tracks apply, replace, explicit remove, undo, and redo", () => {
    const applied = historyOf(pageNumbers(first))
    const replaced = commit(applied, pageNumbers(second, first))
    const removed = commit(replaced, pageNumbers(null, second))

    expect(pageNumbersConfig(applied)).toEqual(first)
    expect(pageNumbersConfig(replaced)).toEqual(second)
    expect(pageNumbersConfig(removed)).toBeNull()
    expect(pageNumbersConfig(undo(removed)!.history)).toEqual(second)
    expect(pageNumbersConfig(redo(undo(removed)!.history)!.history)).toBeNull()
  })

  it("plans previous from the queue's history and skips a no-op", () => {
    const queued = historyOf(pageNumbers(first), highlight(2))
    const planned = planPageNumbersChange(queued, second, 3)!

    expect(planned.command.previous).toEqual(first)
    expect(pageNumbersConfig(planned.history)).toEqual(second)
    expect(planPageNumbersChange(planned.history, second, 3)).toBeNull()
  })

  it("is independent of the watermark layer in one history", () => {
    const wm = defaultWatermarkConfig("DRAFT")
    const history = historyOf(watermark(wm), pageNumbers(first))

    expect(watermarkConfig(history)).toEqual(wm)
    expect(pageNumbersConfig(history)).toEqual(first)
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

describe("nextUndoCommand and nextRedoCommand", () => {
  it("names the step each direction would take", () => {
    const history = historyOf(highlight(1), highlight(2))
    const undone = undo(history)!.history

    expect(nextUndoCommand(history)).toBe(history.past[1]!.command)
    expect(nextRedoCommand(history)).toBeNull()
    expect(nextUndoCommand(undone)).toBe(history.past[0]!.command)
    expect(nextRedoCommand(undone)).toBe(history.past[1]!.command)
  })

  it("names nothing on an untouched document", () => {
    expect(nextUndoCommand(emptyHistory)).toBeNull()
    expect(nextRedoCommand(emptyHistory)).toBeNull()
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
    const insertFile: AnnotationCommand = {
      index: 2,
      insertedCount: 0,
      kind: "insertFile",
      pageCount: 3,
      path: "/b.pdf",
      stashId: 1,
    }

    for (const command of [reorder, del, insert, insertFile]) {
      expect(movesPages(command)).toBe(true)
    }

    // An annotation, watermark, page number or turn leaves every page where it
    // was, so undoing one must not discard a note the reader is still typing.
    for (const command of [
      highlight(1),
      watermark(null),
      pageNumbers(pageNumbersConfigValue()),
      planRotatePages(emptyHistory, [1], 90)!.command,
    ]) {
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

  it("invalidates only the pages it moves, bitmaps and text alike", () => {
    const reorder = planReorderPages(emptyHistory, [2, 1, 3])!.command
    const deletion = planDeletePages(emptyHistory, [3], 4)!.command
    const insertion = planInsertBlankPage(emptyHistory, 2, 3)!.command

    // Page 3 keeps its number, so it keeps its bitmap; a long document redrawn
    // whole would cost a render per visible thumbnail for nothing.
    expect(commandPages(reorder)).toEqual([1, 2])
    expect(commandTextPages(reorder)).toEqual([1, 2])
    // Delete invalidates from the first page taken out, against the wider,
    // pre-delete shape of the document.
    expect(commandPages(deletion)).toEqual([3, 4])
    // Insert invalidates from the gap, against the wider, post-insert shape.
    expect(commandPages(insertion)).toEqual([2, 3, 4])
    expect(commandTextPages(insertion)).toEqual([2, 3, 4])
  })

  it("names the same pages for a reorder's undo as for its apply", () => {
    const order = [3, 1, 2, 4]
    const reorder = planReorderPages(emptyHistory, order)!.command as {
      inverse: number[]
      kind: "reorderPages"
      order: number[]
    }

    // The undo re-enters through the same command, so one expression has to
    // cover both directions — which it does, since a permutation and its
    // inverse leave exactly the same positions untouched.
    expect(commandPages(reorder)).toEqual([1, 2, 3])
    expect(commandPages({ ...reorder, order: reorder.inverse })).toEqual([
      1, 2, 3,
    ])
  })
})

describe("insert-file commands", () => {
  it("plans an insert with the file's page count unknown until it is read", () => {
    const history = historyOf(highlight(1))
    const planned = planInsertFile(history, "/b.pdf", 2, 3)!

    expect(planned.command).toEqual({
      index: 2,
      insertedCount: 0,
      kind: "insertFile",
      pageCount: 3,
      path: "/b.pdf",
      stashId: history.nextId,
    })
    // The stash rides the entry id, so the undo's delete and its redo's restore
    // pair up exactly, as every structure command's do.
    expect(planned.history.past.at(-1)!.id).toBe(planned.command.stashId)
  })

  it("refuses a position the document does not have", () => {
    expect(planInsertFile(emptyHistory, "/b.pdf", 0, 3)).toBeNull()
    expect(planInsertFile(emptyHistory, "/b.pdf", 5, 3)).toBeNull()
    // One past the end is a position: the file goes after the last page.
    expect(planInsertFile(emptyHistory, "/b.pdf", 4, 3)).not.toBeNull()
  })

  it("invalidates the gap and everything after it, not the pages before", () => {
    const command = planInsertFile(emptyHistory, "/b.pdf", 2, 3)!.command

    expect(commandPages(command)).toEqual([2, 3])
    expect(commandTextPages(command)).toEqual([2, 3])
  })

  it("invalidates nothing when the file goes after the last page", () => {
    const command = planInsertFile(emptyHistory, "/b.pdf", 4, 3)!.command

    // Pages 1-3 keep their numbers and their pixels; the pages the file brings
    // are components that mount for the first time and fetch on their own.
    expect(commandPages(command)).toEqual([])
  })

  it("invalidates the file's own pages once the apply has counted them", () => {
    const planned = planInsertFile(emptyHistory, "/b.pdf", 4, 3)!
    const id = planned.history.past.at(-1)!.id
    const filled = fillInsertFileOutcome(planned.history, id, 2)

    // What the undo takes back out, so the undo invalidates it.
    expect(commandPages(filled.past.at(-1)!.command)).toEqual([4, 5])
  })

  it("fills the page count the first apply learned", () => {
    const planned = planInsertFile(historyOf(highlight(1)), "/b.pdf", 3, 4)!
    const id = planned.history.past.at(-1)!.id
    const filled = fillInsertFileOutcome(planned.history, id, 4)
    const command = filled.past.at(-1)!.command

    // Four pages arrived, so the document now has eight.
    expect(command).toMatchObject({ insertedCount: 4, pageCount: 8 })
    // The delete an undo runs, and the restore a redo runs, cover the file's own
    // range — pages 3 through 6.
    expect(insertFilePages(command as never)).toEqual([3, 4, 5, 6])
  })
})

describe("cross-document insert commands", () => {
  it("plans an insert of the pages a drag brought from another document", () => {
    const history = historyOf(highlight(1))
    const planned = planInsertPages(history, 7, [4, 2], 2, 3)!

    expect(planned.command).toEqual({
      index: 2,
      kind: "insertPages",
      pageCount: 5,
      sourceDocumentId: 7,
      // Sorted and deduplicated: the block lands in the order the source grid
      // shows it, whichever page of it the reader happened to grab.
      sourcePages: [2, 4],
      stashId: history.nextId,
    })
    expect(planned.history.past.at(-1)!.id).toBe(planned.command.stashId)
  })

  it("refuses a position the document does not have, and an empty block", () => {
    expect(planInsertPages(emptyHistory, 7, [1], 0, 3)).toBeNull()
    expect(planInsertPages(emptyHistory, 7, [1], 5, 3)).toBeNull()
    expect(planInsertPages(emptyHistory, 7, [], 2, 3)).toBeNull()
    // One past the end is a position: the pages go after the last one.
    expect(planInsertPages(emptyHistory, 7, [1], 4, 3)).not.toBeNull()
  })

  it("invalidates the gap and everything after it, and moves the pages", () => {
    const command = planInsertPages(emptyHistory, 7, [1, 2], 2, 3)!.command

    expect(commandPages(command)).toEqual([2, 3, 4, 5])
    expect(commandTextPages(command)).toEqual([2, 3, 4, 5])
    expect(movesPages(command)).toBe(true)
  })

  it("names the block its undo deletes and its redo restores", () => {
    const command = planInsertPages(emptyHistory, 7, [1, 3, 4], 3, 5)!.command

    expect(insertPagesRange(command as never)).toEqual([3, 4, 5])
  })
})

describe("turning pages", () => {
  it("plans one turn of the pages the grid chose", () => {
    const history = historyOf(highlight(1))
    const planned = planRotatePages(history, [3, 1, 3], 90)!

    expect(planned.command).toEqual({
      degrees: 90,
      kind: "rotatePages",
      // Sorted and deduplicated: the undo turns back exactly what turned.
      pages: [1, 3],
    })
    expect(planned.history.past).toHaveLength(2)
  })

  it("refuses an empty selection and a turn that comes to nothing", () => {
    expect(planRotatePages(emptyHistory, [], 90)).toBeNull()
    expect(planRotatePages(emptyHistory, [1], 0)).toBeNull()
    expect(planRotatePages(emptyHistory, [1], 360)).toBeNull()
  })

  it("keeps the turn inside one clockwise circle", () => {
    expect(planRotatePages(emptyHistory, [1], 450)!.command.degrees).toBe(90)
    expect(planRotatePages(emptyHistory, [1], -90)!.command.degrees).toBe(270)
  })

  it("redraws the pages that turned and no others, text included", () => {
    const command = planRotatePages(emptyHistory, [2, 4], 90)!.command

    expect(commandPages(command)).toEqual([2, 4])
    // The spans keep their places in the page's own space; only the layer
    // drawn over them turns, so nothing has to be extracted again.
    expect(commandTextPages(command)).toEqual([])
  })
})

describe("pasting the document's own pages", () => {
  it("plans a copy of the pages the reader took, in the grid's order", () => {
    const history = historyOf(highlight(1))
    const planned = planDuplicatePages(history, [3, 1, 3], 2, 3)!

    expect(planned.command).toEqual({
      index: 2,
      kind: "duplicatePages",
      pageCount: 5,
      // Sorted and deduplicated, as a dragged block is: what the undo deletes
      // has to be the range the backend copied.
      sourcePages: [1, 3],
      stashId: history.nextId,
    })
    expect(planned.history.past.at(-1)!.id).toBe(planned.command.stashId)
  })

  it("refuses a position the document does not have, and an empty block", () => {
    expect(planDuplicatePages(emptyHistory, [1], 0, 3)).toBeNull()
    expect(planDuplicatePages(emptyHistory, [1], 5, 3)).toBeNull()
    expect(planDuplicatePages(emptyHistory, [], 2, 3)).toBeNull()
    // One past the end is a position: the copies go after the last page.
    expect(planDuplicatePages(emptyHistory, [1], 4, 3)).not.toBeNull()
  })

  it("invalidates the gap and everything after it, and moves the pages", () => {
    const command = planDuplicatePages(emptyHistory, [1, 2], 2, 3)!.command

    expect(commandPages(command)).toEqual([2, 3, 4, 5])
    expect(commandTextPages(command)).toEqual([2, 3, 4, 5])
    expect(movesPages(command)).toBe(true)
  })

  it("names the block its undo deletes and its redo restores", () => {
    const command = planDuplicatePages(emptyHistory, [1, 3, 4], 3, 5)!.command

    expect(insertPagesRange(command)).toEqual([3, 4, 5])
  })
})

describe("erasing a mark", () => {
  /** The ids of the entries the history holds, oldest first. */
  function applied(history: AnnotationHistory) {
    return history.past.map((entry) => entry.id)
  }

  it("takes the mark's entry out of the applied history", () => {
    const history = historyOf(highlight(1), highlight(2), highlight(3))
    const target = history.past[0]!.id
    const planned = planEraseAnnotation(history, target)!

    expect(applied(planned.history)).toEqual([2, 3, 4])
    expect(planned.command).toMatchObject({ index: 0, kind: "eraseAnnotation" })
    // The erase is an edit like any other, so a redo branch it starts from is
    // dropped the same way.
    expect(planned.history.future).toEqual([])
  })

  it("has nothing to erase for an entry the reader has already undone", () => {
    const history = historyOf(highlight(1))
    const undone = undo(history)!.history

    expect(planEraseAnnotation(undone, history.past[0]!.id)).toBeNull()
  })

  it("puts the entry back where it stood when the erase is undone", () => {
    const history = historyOf(highlight(1), highlight(2), highlight(3))
    const erased = planEraseAnnotation(history, history.past[1]!.id)!.history
    const restored = undo(erased)!.history

    expect(applied(restored)).toEqual([1, 2, 3])
    // …and a redo takes it back out again.
    expect(applied(redo(restored)!.history)).toEqual([1, 3, 4])
  })

  it("leaves the document dirty until the erase is taken back", () => {
    const history = markSaved(historyOf(highlight(1), highlight(2)))
    const erased = planEraseAnnotation(history, history.past[0]!.id)!.history

    expect(isDirty(erased)).toBe(true)
    // Undoing it puts the document back at exactly what was saved.
    expect(isDirty(undo(erased)!.history)).toBe(false)
  })

  it("stays dirty where the erase itself was what was saved", () => {
    const history = historyOf(highlight(1), highlight(2))
    const erased = markSaved(
      planEraseAnnotation(history, history.past[0]!.id)!.history,
    )

    // The file on disk has no first highlight; putting it back is a change.
    expect(isDirty(undo(erased)!.history)).toBe(true)
  })

  it("redraws where the marks were made until the backend says otherwise", () => {
    const history = historyOf(highlight(1, 2))
    const planned = planEraseAnnotation(history, history.past[0]!.id)!
    const id = planned.history.past.at(-1)!.id

    expect(commandPages(planned.command)).toEqual([1, 2])
    expect(movesPages(planned.command)).toBe(false)
    // An annotation is not page content, so nothing extractable moved.
    expect(commandTextPages(planned.command)).toEqual([])

    const filled = fillErasedPages(planned.history, id, [4, 5])

    expect(commandPages(filled.past.at(-1)!.command)).toEqual([4, 5])
  })
})

describe("retargetCommand", () => {
  it("aims a highlight at the pages its marks were really on", () => {
    expect(retargetCommand(highlight(1, 2), [5, 6])).toMatchObject({
      targets: [{ pageNumber: 5 }, { pageNumber: 6 }],
    })
  })

  it("aims a single-page command at the page its mark was on", () => {
    const note: AnnotationCommand = {
      kind: "textNote",
      origin: { left: 10, top: 10 },
      pageNumber: 1,
      style: { color: "#111827", fontSize: 12, opacity: 1 },
      text: "hi",
    }

    expect(retargetCommand(note, [7])).toMatchObject({ pageNumber: 7 })
  })

  it("leaves the command alone where the backend reported nothing", () => {
    const command = highlight(1, 2)

    expect(retargetCommand(command, [])).toBe(command)
  })
})
