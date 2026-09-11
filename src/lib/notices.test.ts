import { describe, expect, test } from "bun:test"

import en from "@/i18n/locales/en"
import zhCN from "@/i18n/locales/zh-CN"
import {
  dismissNotice,
  isPageNotice,
  noticeActions,
  noticeCatalogue,
  noticeClockKey,
  noticeId,
  overflowNotices,
  raiseNotice,
  retractNotices,
  updateNotice,
  visibleNotices,
  workspaceOwner,
  type Notice,
  type NoticeInput,
  type NoticeKind,
} from "@/lib/notices"

const documentOwner = (documentId: number) =>
  ({ documentId, scope: "document" }) as const

function raiseAll(inputs: NoticeInput[]): Notice[] {
  return inputs.reduce<Notice[]>(
    (list, input, index) => raiseNotice(list, input, index + 1),
    [],
  )
}

function reads(locale: unknown, key: string): boolean {
  const path = key.split(".")
  const leaf = path.pop()
  let node: unknown = locale

  for (const step of path) {
    if (typeof node !== "object" || node === null) {
      return false
    }
    node = (node as Record<string, unknown>)[step]
  }

  if (typeof node !== "object" || node === null || leaf === undefined) {
    return false
  }

  const holder = node as Record<string, unknown>

  // A plural key is spelled only in its forms, so the base name the catalogue
  // carries is a real key exactly when both of them are there.
  return (
    typeof holder[leaf] === "string" ||
    (typeof holder[`${leaf}_one`] === "string" &&
      typeof holder[`${leaf}_other`] === "string")
  )
}

describe("noticeCatalogue", () => {
  // The typed `t` cannot check a key the catalogue holds as data, and the
  // plural forms are past `tsc`'s parity check too, so both are checked here.
  test("names a message both locales can read", () => {
    const keys = Object.values(noticeCatalogue).flatMap((entry) => [
      entry.textKey,
      ...("detailKey" in entry ? [entry.detailKey] : []),
    ])

    expect(keys.filter((key) => !reads(en, key))).toEqual([])
    expect(keys.filter((key) => !reads(zhCN, key))).toEqual([])
  })

  test("names a button both locales can read", () => {
    const keys = Object.values(noticeActions).flatMap((action) => [
      action.labelKey,
      ...("busyLabelKey" in action ? [action.busyLabelKey] : []),
    ])

    expect(keys.filter((key) => !reads(en, key))).toEqual([])
    expect(keys.filter((key) => !reads(zhCN, key))).toEqual([])
  })
})

describe("noticeId", () => {
  test("keeps two documents' identical refusals apart", () => {
    expect(noticeId("saveFailed", documentOwner(1))).not.toBe(
      noticeId("saveFailed", documentOwner(2)),
    )
  })

  test("gives the kinds sharing a slot one identity", () => {
    expect(noticeId("pagesCut", documentOwner(1))).toBe(
      noticeId("pagesCopied", documentOwner(1)),
    )
    expect(noticeId("updateAvailable", workspaceOwner)).toBe(
      noticeId("updateReady", workspaceOwner),
    )
  })
})

describe("raiseNotice", () => {
  test("replaces a slot rather than stacking a second row", () => {
    const list = raiseAll([
      { kind: "pagesCut", owner: documentOwner(1) },
      { kind: "pagesCopied", owner: documentOwner(1) },
    ])

    expect(list).toHaveLength(1)
    expect(list[0]?.kind).toBe("pagesCopied")
  })

  test("keeps a repeat's place and gives it a fresh lifetime", () => {
    const first = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "createFailed", owner: workspaceOwner },
    ])
    const again = raiseNotice(
      first,
      { kind: "openFailed", owner: workspaceOwner },
      9,
    )

    expect(again.map((notice) => notice.kind)).toEqual([
      "openFailed",
      "createFailed",
    ])
    expect(again[0]?.sequence).toBe(first[0]?.sequence ?? 0)
    expect(noticeClockKey(again[0]!)).not.toBe(noticeClockKey(first[0]!))
  })

  test("keeps one document's refusal out of another's", () => {
    const list = raiseAll([
      { kind: "saveFailed", owner: documentOwner(1) },
      { kind: "saveFailed", owner: documentOwner(2) },
    ])

    expect(list).toHaveLength(2)
  })

  test("carries what the catalogue cannot know", () => {
    const [notice] = raiseAll([
      {
        action: { busy: true, kind: "noteFont" },
        kind: "pagesCut",
        owner: documentOwner(1),
        progress: { completed: 1, total: 4 },
        values: { count: 2, pages: "2–3" },
      },
    ])

    expect(notice?.values).toEqual({ count: 2, pages: "2–3" })
    expect(notice?.action).toEqual({ busy: true, kind: "noteFont" })
    expect(notice?.progress).toEqual({ completed: 1, total: 4 })
  })
})

describe("dismissNotice", () => {
  test("removes only the notice named", () => {
    const list = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "createFailed", owner: workspaceOwner },
    ])
    const kept = dismissNotice(list, noticeId("openFailed", workspaceOwner))

    expect(kept.map((notice) => notice.kind)).toEqual(["createFailed"])
  })

  test("hands back the very same list when it holds no such notice", () => {
    const list = raiseAll([{ kind: "openFailed", owner: workspaceOwner }])

    expect(dismissNotice(list, "nothing")).toBe(list)
  })
})

describe("retractNotices", () => {
  test("clears everything a closed document held", () => {
    const list = raiseAll([
      { kind: "saveFailed", owner: documentOwner(1) },
      { kind: "pagesCut", owner: documentOwner(1) },
      { kind: "saveFailed", owner: documentOwner(2) },
      { kind: "openFailed", owner: workspaceOwner },
    ])
    const kept = retractNotices(list, documentOwner(1))

    expect(kept.map((notice) => notice.id)).toEqual([
      noticeId("saveFailed", documentOwner(2)),
      noticeId("openFailed", workspaceOwner),
    ])
  })

  test("clears only the kinds named", () => {
    const list = raiseAll([
      { kind: "saveFailed", owner: documentOwner(1) },
      { kind: "annotateFailed", owner: documentOwner(1) },
    ])
    const kept = retractNotices(list, documentOwner(1), ["annotateFailed"])

    expect(kept.map((notice) => notice.kind)).toEqual(["saveFailed"])
  })

  test("takes a whole slot back through any kind that shares it", () => {
    const list = raiseAll([
      { kind: "noteFontFailed", owner: documentOwner(1) },
    ])

    expect(
      retractNotices(list, documentOwner(1), ["noteFontMissing"]),
    ).toHaveLength(0)
  })

  test("leaves the workspace's own alone when a document takes its back", () => {
    const list = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "saveFailed", owner: documentOwner(1) },
    ])

    expect(retractNotices(list, documentOwner(1))).toHaveLength(1)
  })
})

describe("visibleNotices", () => {
  test("holds another document's notices back until its tab returns", () => {
    const list = raiseAll([
      { kind: "saveFailed", owner: documentOwner(1) },
      { kind: "printFailed", owner: documentOwner(2) },
    ])

    expect(visibleNotices(list, 2).map((notice) => notice.kind)).toEqual([
      "printFailed",
    ])
    expect(visibleNotices(list, 1).map((notice) => notice.kind)).toEqual([
      "saveFailed",
    ])
  })

  test("shows the workspace's own whatever tab leads, the home tab included", () => {
    const list = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "saveFailed", owner: documentOwner(1) },
    ])

    expect(visibleNotices(list, null).map((notice) => notice.kind)).toEqual([
      "openFailed",
    ])
  })

  test("puts the standing notice first, where a new one cannot move it", () => {
    const list = raiseAll([
      { kind: "updateReady", owner: workspaceOwner },
      { kind: "openFailed", owner: workspaceOwner },
    ])

    expect(visibleNotices(list, null).map((notice) => notice.kind)).toEqual([
      "updateReady",
      "openFailed",
    ])
  })

  // The order is only half of it: what the standing row is worth is that the
  // button on it stays where the reader last saw it, whatever arrives after.
  test("leaves a standing notice where it was as transients come and go", () => {
    const offered = raiseAll([{ kind: "updateReady", owner: workspaceOwner }])
    const placeOf = (list: Notice[]) =>
      visibleNotices(list, null).findIndex(
        (notice) => notice.kind === "updateReady",
      )
    const busy = raiseNotice(
      raiseNotice(offered, { kind: "openFailed", owner: workspaceOwner }, 2),
      { kind: "createFailed", owner: workspaceOwner },
      3,
    )

    expect(placeOf(offered)).toBe(0)
    expect(placeOf(busy)).toBe(0)
    expect(
      placeOf(dismissNotice(busy, noticeId("openFailed", workspaceOwner))),
    ).toBe(0)
  })

  test("shows every transient there is room for", () => {
    const list = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "pagesCut", owner: documentOwner(1) },
    ])

    expect(visibleNotices(list, 1).map((notice) => notice.kind)).toEqual([
      "openFailed",
      "pagesCut",
    ])
  })

  test("caps the stack by dropping the oldest transient", () => {
    const list = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "createFailed", owner: workspaceOwner },
      { kind: "newWindowFailed", owner: workspaceOwner },
      { kind: "invalidFile", owner: workspaceOwner },
    ])

    expect(visibleNotices(list, null).map((notice) => notice.kind)).toEqual([
      "createFailed",
      "newWindowFailed",
      "invalidFile",
    ])
  })

  test("never drops a standing notice for the count", () => {
    const list = raiseAll([
      { kind: "updateReady", owner: workspaceOwner },
      { kind: "noteFontMissing", owner: documentOwner(1) },
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "createFailed", owner: workspaceOwner },
    ])
    const shown = visibleNotices(list, 1).map((notice) => notice.kind)

    expect(shown).toEqual(["updateReady", "noteFontMissing", "createFailed"])
  })
})

describe("overflowNotices", () => {
  test("names the transients the stack had no room for", () => {
    const list = raiseAll([
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "createFailed", owner: workspaceOwner },
      { kind: "newWindowFailed", owner: workspaceOwner },
      { kind: "invalidFile", owner: workspaceOwner },
    ])

    expect(overflowNotices(list, null).map((notice) => notice.kind)).toEqual([
      "openFailed",
    ])
  })

  test("leaves a waiting tab's notices alone, which are held rather than lost", () => {
    const list = raiseAll([
      { kind: "saveFailed", owner: documentOwner(1) },
      { kind: "printFailed", owner: documentOwner(2) },
    ])

    expect(overflowNotices(list, 2)).toEqual([])
  })

  test("counts a standing notice against the room there is", () => {
    const list = raiseAll([
      { kind: "updateReady", owner: workspaceOwner },
      { kind: "noteFontMissing", owner: documentOwner(1) },
      { kind: "openFailed", owner: workspaceOwner },
      { kind: "createFailed", owner: workspaceOwner },
    ])

    expect(overflowNotices(list, 1).map((notice) => notice.kind)).toEqual([
      "openFailed",
    ])
  })
})

describe("isPageNotice", () => {
  test("marks the grid's clipboard notices and nothing else", () => {
    expect(isPageNotice("pagesPastedToEnd")).toBe(true)
    expect(isPageNotice("saveFailed")).toBe(false)
  })
})

describe("updateNotice", () => {
  test("says nothing while the check is idle or has been waved away", () => {
    expect(
      updateNotice({
        installFailed: false,
        status: { state: "idle" },
        visible: false,
      }),
    ).toBeNull()
    expect(
      updateNotice({
        installFailed: false,
        status: { state: "ready", version: "1.2.3" },
        visible: false,
      }),
    ).toBeNull()
  })

  test("offers the download, then the bar, then the install", () => {
    const available = updateNotice({
      installFailed: false,
      status: { state: "available", version: "1.2.3" },
      visible: true,
    })
    const downloading = updateNotice({
      installFailed: false,
      status: { received: 3, state: "downloading", total: 9, version: "1.2.3" },
      visible: true,
    })
    const ready = updateNotice({
      installFailed: false,
      status: { state: "ready", version: "1.2.3" },
      visible: true,
    })

    expect(available?.action?.kind).toBe("updateDownload")
    expect(downloading?.progress).toEqual({ completed: 3, total: 9 })
    expect(ready?.action?.kind).toBe("updateInstall")
    expect(ready?.values).toEqual({ version: "1.2.3" })
  })

  test("carries an indeterminate bar until the response says how much there is", () => {
    const notice = updateNotice({
      installFailed: false,
      status: {
        received: 0,
        state: "downloading",
        total: null,
        version: "1.2.3",
      },
      visible: true,
    })

    expect(notice?.progress).toBeNull()
  })

  test("turns the whole notice when the platform refuses the install", () => {
    const notice = updateNotice({
      installFailed: true,
      status: { state: "ready", version: "1.2.3" },
      visible: true,
    })

    expect(notice?.kind satisfies NoticeKind | undefined).toBe(
      "updateInstallFailed",
    )
    expect(noticeCatalogue.updateInstallFailed.tone).toBe("danger")
  })
})
