import { describe, expect, test } from "bun:test"

import { filePreferencesOf } from "./filePreferences"

describe("filePreferencesOf", () => {
  test("keeps the choices the file holds", () => {
    expect(filePreferencesOf({ bookmarks: false, smartPadding: false })).toEqual({
      bookmarks: false,
      smartPadding: false,
    })
  })

  test("falls back choice by choice on what is missing or not a boolean", () => {
    expect(filePreferencesOf({ bookmarks: "yes", smartPadding: false })).toEqual({
      bookmarks: true,
      smartPadding: false,
    })
    expect(filePreferencesOf(undefined)).toEqual({ bookmarks: true, smartPadding: true })
  })
})
