import { describe, expect, it } from "bun:test"

import { isAbortError, PageWorkQueue } from "@/lib/pageWork"

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe("PageWorkQueue", () => {
  it("runs no more than its limit at once, nearest first", async () => {
    const queue = new PageWorkQueue(1)
    const started: string[] = []
    const gate = deferred()
    const distances = new Map([
      ["far", 900],
      ["near", 10],
      ["middle", 300],
    ])
    const run = (name: string) =>
      queue.schedule(
        async () => {
          started.push(name)
          if (name === "first") {
            await gate.promise
          }
        },
        { priority: () => distances.get(name) ?? 0 },
      )

    const all = [run("first"), run("far"), run("near"), run("middle")]

    expect(started).toEqual(["first"])
    gate.resolve()
    await Promise.all(all)

    expect(started).toEqual(["first", "near", "middle", "far"])
  })

  it("reads each waiting task's distance when a slot frees, not when asked", async () => {
    const queue = new PageWorkQueue(1)
    const started: string[] = []
    const gate = deferred()
    let aDistance = 0
    const first = queue.schedule(() => gate.promise, { priority: () => 0 })
    const a = queue.schedule(async () => void started.push("a"), {
      priority: () => aDistance,
    })
    const b = queue.schedule(async () => void started.push("b"), {
      priority: () => 100,
    })

    // The reader scrolled on: "a" is far away by the time a slot frees.
    aDistance = 500
    gate.resolve()
    await Promise.all([first, a, b])

    expect(started).toEqual(["b", "a"])
  })

  it("drops work whose page went away before it was sent", async () => {
    const queue = new PageWorkQueue(1)
    const gate = deferred()
    const sent: string[] = []
    const leaving = new AbortController()

    const first = queue.schedule(() => gate.promise, { priority: () => 0 })
    const dropped = queue.schedule(async () => void sent.push("dropped"), {
      priority: () => 0,
      signal: leaving.signal,
    })
    const kept = queue.schedule(async () => void sent.push("kept"), {
      priority: () => 1,
    })

    leaving.abort()
    expect(isAbortError(await dropped.catch((error) => error))).toBe(true)
    gate.resolve()
    await Promise.all([first, kept])

    expect(sent).toEqual(["kept"])
  })

  it("refuses work whose page is already gone", async () => {
    const queue = new PageWorkQueue()
    const gone = new AbortController()
    gone.abort()

    const refused = queue.schedule(async () => "never", {
      priority: () => 0,
      signal: gone.signal,
    })

    expect(isAbortError(await refused.catch((error) => error))).toBe(true)
  })

  it("keeps going after a task fails", async () => {
    const queue = new PageWorkQueue(1)

    const failed = queue.schedule(() => Promise.reject(new Error("render")), {
      priority: () => 0,
    })
    const next = queue.schedule(async () => "painted", { priority: () => 1 })

    await expect(failed).rejects.toThrow("render")
    expect(await next).toBe("painted")
  })
})
