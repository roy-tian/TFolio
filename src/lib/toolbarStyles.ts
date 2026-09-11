/** The bar under the pressed item of a switch-like toolbar group — view mode,
    and the drawing tools — so a chosen button reads apart from a hovered one. */
const selectionBarShape =
  "relative after:pointer-events-none after:absolute after:inset-x-2 after:bottom-1 after:h-0.5 after:rounded-full after:opacity-0 after:transition-opacity aria-pressed:after:opacity-100"

/** Blue is the menu button's, the toolbar's one accent. */
export const toolbarSelectionBarClassName = `${selectionBarShape} after:bg-blue-600 dark:after:bg-blue-400`

/** The ring keeps an ink close to the toolbar's own colour from vanishing. */
export const toolbarInkBarClassName = `${selectionBarShape} after:bg-(--tool-ink) after:ring-1 after:ring-foreground/25`
