import { useLayoutEffect } from "react"

let standing = 0

/** Marks the document while a modal's backdrop stands. Over the desktop the
    docked sidebar is only partly opaque, so the backdrop's blurred copy of it
    is too, and the sharp sidebar beneath shows through: `index.css` makes it
    opaque meanwhile. */
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
