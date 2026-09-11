import type { AnnotationCommand } from "@/lib/annotations"

type HistoryActionKey =
  | "annotate.actionHighlight"
  | "annotate.actionRect"
  | "annotate.actionTextNote"
  | "annotate.actionErase"
  | "annotate.actionWatermarkAdd"
  | "annotate.actionWatermarkChange"
  | "annotate.actionWatermarkRemove"
  | "annotate.actionPageNumbersAdd"
  | "annotate.actionPageNumbersChange"
  | "annotate.actionPageNumbersRemove"
  | "annotate.actionReorderPages"
  | "annotate.actionRotatePages"
  | "annotate.actionDeletePages"
  | "annotate.actionInsertBlankPage"
  | "annotate.actionInsertFile"
  | "annotate.actionInsertPages"
  | "annotate.actionDuplicatePages"

/** The name of an edit, for the undo and redo labels: the locale key that
    names it, and the page count where the name counts pages. */
export type HistoryAction = {
  count?: number
  key: HistoryActionKey
}

/**
 * Named for the reader, not the tool: a watermark command is told apart by
 * what it leaves behind, all three of adding, changing and clearing being it.
 */
export function historyAction(command: AnnotationCommand): HistoryAction {
  switch (command.kind) {
    case "highlight":
      return { key: "annotate.actionHighlight" }
    case "rect":
      return { key: "annotate.actionRect" }
    case "textNote":
      return { key: "annotate.actionTextNote" }
    case "eraseAnnotation":
      return { key: "annotate.actionErase" }
    case "watermark":
      return {
        key: !command.config
          ? "annotate.actionWatermarkRemove"
          : command.previous
            ? "annotate.actionWatermarkChange"
            : "annotate.actionWatermarkAdd",
      }
    case "pageNumbers":
      return {
        key: !command.config
          ? "annotate.actionPageNumbersRemove"
          : command.previous
            ? "annotate.actionPageNumbersChange"
            : "annotate.actionPageNumbersAdd",
      }
    case "reorderPages":
      return { key: "annotate.actionReorderPages" }
    case "rotatePages":
      return { count: command.pages.length, key: "annotate.actionRotatePages" }
    case "deletePages":
      return { count: command.pages.length, key: "annotate.actionDeletePages" }
    case "insertBlankPage":
      return { key: "annotate.actionInsertBlankPage" }
    case "insertFile":
      return { key: "annotate.actionInsertFile" }
    case "insertPages":
      return {
        count: command.sourcePages.length,
        key: "annotate.actionInsertPages",
      }
    case "duplicatePages":
      return {
        count: command.sourcePages.length,
        key: "annotate.actionDuplicatePages",
      }
  }
}
