import { useLayoutEffect } from "react"

let standing = 0

/** Marks the document while a modal's backdrop stands. Over native window
    materials, translucent surfaces make the backdrop's blurred copy as
    see-through as they are, letting sharp UI words show through: `index.css`
    turns them solid meanwhile. */
export function useModalMark() {
  useLayoutEffect(() => {
    standing += 1
    document.documentElement.dataset.modalOpen = ""

    return () => {
      standing -= 1

      if (standing === 0) {
        delete document.documentElement.dataset.modalOpen
      }
    }
  }, [])
}
