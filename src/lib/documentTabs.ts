/** The strip's fixed first tab. It is not a document, so it needs an id no
    backend document id can be. */
export const HOME_TAB_ID = "home" as const

export type TabId = number | typeof HOME_TAB_ID

/** The strip and the panel it reveals name each other by id, so both sides
    build those ids here rather than repeating the format. */
export function tabElementId(tabId: TabId) {
  return `workspace-tab-${tabId}`
}

export function panelElementId(tabId: TabId) {
  return `workspace-panel-${tabId}`
}

export type DocumentTabIdentity = {
  id: number
  path: string
}

export function tabIdForPath(
  tabs: readonly DocumentTabIdentity[],
  path: string,
): number | null {
  return tabs.find((tab) => tab.path === path)?.id ?? null
}

export function selectOpenedTabId(
  openedIds: readonly number[],
  currentTabIds: readonly number[],
  activate: "first" | "last",
): number | null {
  const currentIds = new Set(currentTabIds)
  const survivingIds = openedIds.filter((id) => currentIds.has(id))

  return activate === "first"
    ? survivingIds[0] ?? null
    : survivingIds.at(-1) ?? null
}

export function activeTabAfterClose(
  tabIds: readonly TabId[],
  activeId: TabId,
  closingId: number,
): TabId {
  const closingIndex = tabIds.indexOf(closingId)

  if (closingIndex < 0 || activeId !== closingId) {
    return activeId
  }

  // Home leads the strip, so a closed document always has a neighbour to fall
  // back to and the workspace never lands on nothing.
  return tabIds[closingIndex + 1] ?? tabIds[closingIndex - 1] ?? HOME_TAB_ID
}

/** The document tabs' order after a strip drag of the one at `from` onto
    `to`, both indices among the documents — home leads and never moves. An
    out-of-range or same-place move returns the same list, reference and all. */
export function reorderedTabs<T>(
  tabs: T[],
  from: number,
  to: number,
): T[] {
  if (
    from === to ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= tabs.length ||
    to >= tabs.length
  ) {
    return tabs
  }

  const next = [...tabs]
  const [moved] = next.splice(from, 1)

  next.splice(to, 0, moved)
  return next
}

export function tabIdForKey(
  tabIds: readonly TabId[],
  activeId: TabId,
  key: string,
): TabId | null {
  const activeIndex = tabIds.indexOf(activeId)

  if (activeIndex < 0 || tabIds.length === 0) {
    return null
  }

  switch (key) {
    case "ArrowLeft":
      return tabIds[(activeIndex - 1 + tabIds.length) % tabIds.length] ?? null
    case "ArrowRight":
      return tabIds[(activeIndex + 1) % tabIds.length] ?? null
    case "Home":
      return tabIds[0] ?? null
    case "End":
      return tabIds.at(-1) ?? null
    default:
      return null
  }
}
