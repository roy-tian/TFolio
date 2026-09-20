/** The bar under the pressed item of a switch-like toolbar group — view mode,
    and the drawing tools — so a chosen button reads apart from a hovered one. */
const selectionBarShape =
  "relative after:pointer-events-none after:absolute after:inset-x-2 after:bottom-1 after:h-0.5 after:rounded-full after:opacity-0 after:transition-opacity aria-pressed:after:opacity-100"

/** The brand navy is the menu button's, the toolbar's one accent. */
export const toolbarSelectionBarClassName = `${selectionBarShape} after:bg-brand`

/** The ring keeps an ink close to the toolbar's own colour from vanishing. */
export const toolbarInkBarClassName = `${selectionBarShape} after:bg-(--tool-ink) after:ring-1 after:ring-foreground/25`

/** The groups' border merge drops every child-after-the-first's left border,
    skewing the padding box the strip centres in — a transparent one restores it. */
export const toolbarCenteredStripButtonClassName =
  "not-first:border-l! not-first:border-l-transparent"

/** A sliver rather than a second button's width, its chevron in the bottom
    corner: the control beside it is what the reader aims at, not this. */
export const splitMenuButtonClassName =
  "relative w-3.5 items-end border-input px-0 pb-1 before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-border before:opacity-0 before:transition-opacity hover:before:opacity-100"
