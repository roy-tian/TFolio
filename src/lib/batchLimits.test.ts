import { describe, expect, test } from "bun:test"

import {
  fittingFiles,
  MERGE_BYTES_AT_ONCE,
  MERGE_FILES_AT_ONCE,
  mergeLimit,
} from "./batchLimits"

const MB = 1024 * 1024

describe("fittingFiles", () => {
  test("takes files from the first until either limit", () => {
    expect(fittingFiles([1, 1, 1, 1], 3, 100)).toBe(3)
    expect(fittingFiles([40, 40, 40], 10, 100)).toBe(2)
    expect(fittingFiles([40, 60, 1], 10, 100)).toBe(2)
  })

  test("takes none when the first is past the size limit alone", () => {
    expect(fittingFiles([101, 1], 10, 100)).toBe(0)
  })
})

describe("mergeLimit", () => {
  test("meets none within both limits", () => {
    expect(mergeLimit(Array.from({ length: MERGE_FILES_AT_ONCE }, () => MB))).toBeNull()
  })

  test("meets the count past the files a go takes", () => {
    expect(mergeLimit(Array.from({ length: MERGE_FILES_AT_ONCE + 2 }, () => MB))).toEqual({
      by: "count",
      fit: MERGE_FILES_AT_ONCE,
      kind: "merge",
      total: MERGE_FILES_AT_ONCE + 2,
    })
  })

  test("meets the size past the bytes a go takes, saying what they come to", () => {
    const half = MERGE_BYTES_AT_ONCE / 2

    expect(mergeLimit([half, half, MB])).toEqual({
      by: "bytes",
      bytes: MERGE_BYTES_AT_ONCE + MB,
      fit: 2,
      kind: "merge",
      total: 3,
    })
  })
})
