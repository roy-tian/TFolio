import { describe, expect, test } from "bun:test"

import { filePreferencesOf } from "./filePreferences"

describe("filePreferencesOf", () => {
  test("keeps the choices the file holds", () => {
    expect(filePreferencesOf({ smartPadding: false })).toEqual({ smartPadding: false })
  })

  test("falls back choice by choice on what is missing or not a boolean", () => {
    expect(filePreferencesOf({ smartPadding: "yes" })).toEqual({ smartPadding: true })
    expect(filePreferencesOf(undefined)).toEqual({ smartPadding: true })
  })
})
