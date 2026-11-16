/** At most this many files open from one choice or drop. */
export const OPEN_FILES_AT_ONCE = 8

/** One add or merge reads at most this many files, and at most this many bytes
    of them on disk: the engine's `MAX_MERGE_FILES` and `MAX_MERGE_BYTES`,
    which refuse whatever gets past the reader's answer. */
export const MERGE_FILES_AT_ONCE = 256
export const MERGE_BYTES_AT_ONCE = 512 * 1024 * 1024

/** More files than one go takes, put to the reader: the first `fit` of
    `total`, or none. `bytes` is what they come to, past a size limit. */
export type BatchLimit =
  | { by: "count"; fit: number; kind: "merge" | "open"; total: number }
  | { by: "bytes"; bytes: number; fit: number; kind: "merge"; total: number }

/** Whether to go ahead with the files that fit. */
export type AskBatchLimit = (limit: BatchLimit) => Promise<boolean>

/** How many of the files, from the first, one go takes: within `maxFiles`, and
    within `maxBytes` of the files' `sizes` together. */
export function fittingFiles(sizes: readonly number[], maxFiles: number, maxBytes: number) {
  let bytes = 0
  let fit = 0

  for (const size of sizes.slice(0, maxFiles)) {
    if (bytes + size > maxBytes) {
      break
    }

    bytes += size
    fit += 1
  }

  return fit
}

/** The limit an add or merge of files this size meets, if any. */
export function mergeLimit(sizes: readonly number[]): BatchLimit | null {
  const fit = fittingFiles(sizes, MERGE_FILES_AT_ONCE, MERGE_BYTES_AT_ONCE)

  if (fit === sizes.length) {
    return null
  }

  // Cut short by the count only when the files it keeps fit in size too.
  return fit === MERGE_FILES_AT_ONCE
    ? { by: "count", fit, kind: "merge", total: sizes.length }
    : {
        by: "bytes",
        bytes: sizes.reduce((total, size) => total + size, 0),
        fit,
        kind: "merge",
        total: sizes.length,
      }
}
