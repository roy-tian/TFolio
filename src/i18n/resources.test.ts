import { describe, expect, test } from "bun:test"

import en from "./locales/en"
import { translations } from "./resources"

type Tree = { readonly [key: string]: string | Tree }

function leaves(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[prefix + key, value] as [string, string]]
      : leaves(value, `${prefix}${key}.`),
  )
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^},\s]+)/g)].map((match) => match[1]).sort()
}

// `tsc` holds every locale to en's keys, but not to the names inside them: a
// misspelt placeholder renders as literal braces.
describe("translations", () => {
  const source = new Map(leaves(en))

  test.each(Object.entries(translations))(
    "%s interpolates exactly what en does",
    (_, locale) => {
      const mismatches = leaves(locale).flatMap(([key, text]) => {
        // A singular may spell its count out ("1 page"), and any plural form may
        // need the count where en's does not. An `_other` that en counts must
        // count too: Chinese and Thai show it for every number, one included.
        const expectedNames = placeholders(source.get(key) ?? "")
        const optional =
          key.endsWith("_one") ||
          (key.endsWith("_other") && !expectedNames.includes("count"))
        const comparable = (names: string[]) =>
          optional ? names.filter((name) => name !== "count") : names
        const expected = comparable(expectedNames).join()
        const actual = comparable(placeholders(text)).join()

        return text.trim() && actual === expected
          ? []
          : [`${key}: [${actual}] vs en [${expected}]`]
      })

      expect(mismatches).toEqual([])
    },
  )
})
