import { createContext, useContext } from "react"

/** What a file drag makes of the shown tab's sidebar pages: a target that
    combines the dragged files with the tab's own ("over" while the pointer is
    on it), or nothing at all. */
export type PagesDrop = "offered" | "over" | null

export const PagesDropContext = createContext<PagesDrop>(null)

export function usePagesDrop() {
  return useContext(PagesDropContext)
}
