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
  tabIds: readonly number[],
  activeId: number | null,
  closingId: number,
): number | null {
  const closingIndex = tabIds.indexOf(closingId)

  if (closingIndex < 0) {
    return activeId
  }

  if (activeId !== closingId) {
    return activeId
  }

  return tabIds[closingIndex + 1] ?? tabIds[closingIndex - 1] ?? null
}

export function tabIdForKey(
  tabIds: readonly number[],
  activeId: number,
  key: string,
): number | null {
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
