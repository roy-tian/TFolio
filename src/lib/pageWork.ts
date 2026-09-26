/**
 * PDFium serves one request at a time behind one lock, and a command, once
 * sent, is a blocking task queued in Rust that nothing can call back. So what
 * is not yet needed waits here instead, where it can still be dropped — a page
 * flung past — or overtaken by the page the reader stopped on.
 */

type Task = {
  priority: () => number
  signal?: AbortSignal
  start: () => void
  drop: () => void
}

export class PageWorkQueue {
  private readonly limit: number
  private running = 0
  private readonly waiting = new Set<Task>()

  constructor(limit = 2) {
    this.limit = limit
  }

  /** `priority` is read when a slot frees, lowest first — so it can measure
      the page where it is then, not where it was when asked. */
  schedule<T>(
    work: () => Promise<T>,
    { priority, signal }: { priority: () => number; signal?: AbortSignal },
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortError())
    }

    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        drop: () => {
          this.waiting.delete(task)
          reject(abortError())
        },
        priority,
        signal,
        start: () => {
          signal?.removeEventListener("abort", task.drop)
          this.running += 1
          // A throw before `work` returns its promise must still free the slot.
          new Promise<T>((run) => run(work()))
            .then(resolve, reject)
            .finally(() => {
              this.running -= 1
              this.pump()
            })
        },
      }

      signal?.addEventListener("abort", task.drop, { once: true })
      this.waiting.add(task)
      this.pump()
    })
  }

  private pump() {
    while (this.running < this.limit && this.waiting.size > 0) {
      let next: Task | null = null
      let best = Number.POSITIVE_INFINITY

      for (const task of this.waiting) {
        const priority = task.priority()

        if (next === null || priority < best) {
          next = task
          best = priority
        }
      }

      this.waiting.delete(next!)
      next!.start()
    }
  }
}

function abortError() {
  return new DOMException("the page work was dropped", "AbortError")
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

/** How far an element sits outside its scroll root's view, in pixels; zero
    for one in view. What the queue orders page work by. */
export function distanceFromView(element: Element | null): number {
  // No box, as in a hidden tab, measures all zeros, which would read as in view.
  if (!element || !element.isConnected || element.getClientRects().length === 0) {
    return Number.POSITIVE_INFINITY
  }

  const root =
    element.closest("[data-pdf-scroll-root]") ?? document.documentElement
  const view = root.getBoundingClientRect()
  const box = element.getBoundingClientRect()

  if (box.bottom < view.top) {
    return view.top - box.bottom
  }

  return box.top > view.bottom ? box.top - view.bottom : 0
}

/** One per window: every document's pages share the one PDFium lock. */
export const pageWork = new PageWorkQueue()
