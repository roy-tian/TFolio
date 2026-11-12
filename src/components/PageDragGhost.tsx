import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react"
import { createPortal } from "react-dom"

import { DRAG_MOTION, prefersReducedMotion } from "@/lib/motion"
import { THUMBNAIL_WIDTH } from "@/lib/viewMode"

export type GhostPaper = {
  /** The pressed preview's pixels, copied once: a bitmap the frontend already
      holds, as page bitmaps never become `blob:` URLs. */
  canvas: HTMLCanvasElement | null
  height: number
  /** What is lifted with no canvas — a folded file, by its name — shows
      that name instead. */
  label?: string
  /** The quarter turn the preview shows its upright bitmap at. */
  rotation: number
  width: number
}

export type PageDragGhostHandle = {
  /** Where the pointer is now, in client pixels. */
  moveTo: (point: { x: number; y: number }) => void
  /** Settles the stack onto a paper at this client position, or fades it out
      where it is when there is none to see; resolves once done, at once when
      no motion is wanted. */
  land: (box: { left: number; top: number } | null) => Promise<void>
}

export type PageDragGhostState = {
  count: number
  grip: { x: number; y: number }
  /** The ghost's key. A drag starting before the last one's ghost unmounted
      must not inherit its grip, its pixels or its landing's held transform. */
  id: number
  paper: GhostPaper
  point: { x: number; y: number }
}

// The landing normally ends a drag; this ends it if a motion never reports
// back, so no page stays a hole.
const LANDING_TIMEOUT_MS = 600
let ghostsLifted = 0

/** The ghost of the paper a drag has just lifted, measured rather than
    recomputed so it matches whichever surface it came from. */
export function liftGhost(
  paper: HTMLElement,
  count: number,
  start: { x: number; y: number },
  point: { x: number; y: number },
  label?: string,
): PageDragGhostState {
  const box = paper.getBoundingClientRect()

  ghostsLifted += 1

  return {
    count,
    grip: { x: box.left - start.x, y: box.top - start.y },
    id: ghostsLifted,
    paper: {
      canvas: paper.querySelector("canvas"),
      height: box.height,
      label,
      rotation: Number(paper.dataset.rotation ?? 0),
      width: box.width,
    },
    point,
  }
}

/**
 * The client position a ghost lands on: the paper inside a laid-out cell, read
 * through `offset*` so a slide still running on the cell is ignored. None when
 * that paper is scrolled out of `view`: the ghost would streak across the
 * window to a place nobody sees.
 */
export function landingBox(
  container: HTMLElement,
  cell: HTMLElement | null,
  paperSelector: string,
  view: HTMLElement | null,
) {
  const paper = cell?.querySelector<HTMLElement>(paperSelector)

  if (!cell || !paper || !view) {
    return null
  }

  const origin = container.getBoundingClientRect()
  const cellBox = cell.getBoundingClientRect()
  const paperBox = paper.getBoundingClientRect()
  const shown = view.getBoundingClientRect()
  const left = origin.left + cell.offsetLeft + paperBox.left - cellBox.left
  const top = origin.top + cell.offsetTop + paperBox.top - cellBox.top

  return top < shown.bottom &&
    top + paperBox.height > shown.top &&
    left < shown.right &&
    left + paperBox.width > shown.left
    ? { left, top }
    : null
}

const LIFTED = "rotate(-2deg) scale(1.03)"
// Two cards behind the lead for a block of any size: the stack says "more than
// this one", the badge says how many.
const STACK_STEPS = [8, 4]
const stackTransform = (step: number) =>
  `translate(${step}px, ${step}px) rotate(${step / 2}deg)`

/**
 * The pages in hand: the pressed page lifted and tilted, a stack behind it for
 * more. It follows the pointer by writing its own transform, so the owner
 * re-renders only when the landing place changes, not on every pointer move.
 */
export function PageDragGhost({
  count,
  grip,
  paper,
  point,
  ref,
}: {
  count: number
  /** The paper's top-left less the pointer's, so the grabbed spot stays put. */
  grip: { x: number; y: number }
  paper: GhostPaper
  point: { x: number; y: number }
  ref: Ref<PageDragGhostHandle>
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const liftRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stackRefs = useRef<(HTMLDivElement | null)[]>([])
  const badgeRef = useRef<HTMLSpanElement>(null)
  const placeAt = (at: { x: number; y: number }) =>
    `translate(${at.x + grip.x}px, ${at.y + grip.y}px)`

  useImperativeHandle(
    ref,
    () => ({
      moveTo: (at) => {
        if (frameRef.current) {
          frameRef.current.style.transform = placeAt(at)
        }
      },
      land: async (box) => {
        const frame = frameRef.current
        const lift = liftRef.current

        if (!frame || !lift || prefersReducedMotion()) {
          return
        }

        const settle = { ...DRAG_MOTION, duration: 240, fill: "forwards" } as const
        // The lifted card and whatever stack is behind it go out together.
        const vanish = () => [
          lift.animate(
            [
              { opacity: 1, transform: LIFTED },
              { opacity: 0, transform: "rotate(-2deg) scale(0.9)" },
            ],
            { ...settle, duration: 160 },
          ),
        ]
        const settleOnto = (to: { left: number; top: number }) => [
          frame.animate(
            [
              { transform: frame.style.transform },
              { transform: `translate(${to.left}px, ${to.top}px)` },
            ],
            settle,
          ),
          lift.animate([{ transform: LIFTED }, { transform: "none" }], settle),
          ...stackRefs.current.flatMap((card) =>
            card
              ? [
                  card.animate(
                    [
                      { opacity: 0.7, transform: getComputedStyle(card).transform },
                      { opacity: 0, transform: "none" },
                    ],
                    settle,
                  ),
                ]
              : [],
          ),
          ...(badgeRef.current
            ? [badgeRef.current.animate([{ opacity: 1 }, { opacity: 0 }], settle)]
            : []),
        ]
        const motions = box ? settleOnto(box) : vanish()

        // A cancelled motion rejects; landed or not, the pages come back.
        await Promise.race([
          Promise.all(motions.map((motion) => motion.finished)).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, LANDING_TIMEOUT_MS)),
        ])
      },
    }),
    // `grip` is fixed for the drag the ghost was mounted for.
    [],
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const source = paper.canvas
    const context = canvas?.getContext("2d")

    // An unpainted preview holds a 1×1 placeholder; the paper stays white.
    if (canvas && context && source && source.width > 1 && source.height > 1) {
      const scale = devicePixelRatio
      const turned = paper.rotation % 180 !== 0
      const uprightWidth = (turned ? paper.height : paper.width) * scale
      const uprightHeight = (turned ? paper.width : paper.height) * scale

      canvas.width = Math.round(paper.width * scale)
      canvas.height = Math.round(paper.height * scale)
      context.translate(canvas.width / 2, canvas.height / 2)
      context.rotate((paper.rotation * Math.PI) / 180)
      context.drawImage(
        source,
        -uprightWidth / 2,
        -uprightHeight / 2,
        uprightWidth,
        uprightHeight,
      )
    }

    if (prefersReducedMotion()) {
      return
    }

    const pickup = { duration: 150, easing: "ease-out" }

    liftRef.current?.animate([{ transform: "none" }, { transform: LIFTED }], pickup)
    stackRefs.current.forEach((card, index) => {
      card?.animate(
        [
          { opacity: 0, transform: "none" },
          { opacity: 0.7, transform: stackTransform(STACK_STEPS[index]!) },
        ],
        pickup,
      )
    })
    // Mounted once per drag: the paper it copies does not change under it.
  }, [])

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-60"
      data-drag-ghost
      ref={frameRef}
      style={{ height: paper.height, transform: placeAt(point), width: paper.width }}
    >
      <div
        className="absolute inset-0"
        ref={liftRef}
        style={{ transform: LIFTED, transformOrigin: `${-grip.x}px ${-grip.y}px` }}
      >
        {/* The faint `drop-shadow-xs` on each tilted card smooths its edges:
            WebKitGTK, and Chromium rastering on the GPU, paint a tilted box
            stair-stepped, but draw a filtered one upright and then resample
            it. An identity filter is skipped, and a filter blur costs frames,
            so box-shadows still cast the visible shadow. */}
        {count > 1
          ? STACK_STEPS.map((step, index) => (
              <div
                className="absolute inset-0 bg-white opacity-70 shadow-md ring-1 ring-black/10 drop-shadow-xs"
                key={step}
                ref={(card) => {
                  stackRefs.current[index] = card
                }}
                style={{ transform: stackTransform(step) }}
              />
            ))
          : null}
        {/* Apart from the lead card: inside its filter, this wide shadow's
            whole reach would be filtered again on every move. */}
        <div className="absolute inset-0 shadow-2xl" />
        <div className="absolute inset-0 grid place-items-center overflow-hidden bg-white text-xs text-zinc-400 ring-1 ring-black/10 drop-shadow-xs">
          {paper.canvas ? (
            <canvas className="absolute inset-0 block size-full" ref={canvasRef} />
          ) : (
            <span className="max-w-full truncate px-1 font-medium text-zinc-700">
              {paper.label}
            </span>
          )}
        </div>
        {count > 1 ? (
          <span
            className="absolute -top-2 -right-2 grid min-w-5 place-items-center rounded-full bg-primary px-1 py-0.5 font-mono text-xs font-semibold text-primary-foreground tabular-nums shadow-md"
            ref={badgeRef}
          >
            {count}
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

/** Where the pages in hand will stand: the landing page's own paper, dashed,
    centred in the square every paper stands in. */
export function DragHole({ height, width }: { height: number; width: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-1/2 -translate-x-1/2 border-2 border-dashed border-primary/60 bg-primary/5"
      data-drag-hole
      style={{ height, top: (THUMBNAIL_WIDTH - height) / 2, width }}
    />
  )
}
