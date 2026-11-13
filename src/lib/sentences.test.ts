import { describe, expect, test } from "bun:test"

import { joinSentences } from "./sentences"

describe("joinSentences", () => {
  test("puts a space after a Latin stop", () => {
    expect(joinSentences("It breaks the signature.", "The file is kept.")).toBe(
      "It breaks the signature. The file is kept.",
    )
  })

  test("adds none after a full-width stop", () => {
    expect(joinSentences("修改后签名将失效。", "原文件不会被覆盖。")).toBe(
      "修改后签名将失效。原文件不会被覆盖。",
    )
    expect(joinSentences("変更しますか？", "元のファイルは残ります。")).toBe(
      "変更しますか？元のファイルは残ります。",
    )
  })
})
