import { describe, expect, it } from "bun:test"

import { ImageDecoder, type DecodeWorker } from "@/lib/imageDecode"
import type { DecodeReply, DecodeRequest } from "@/lib/imageDecodeWorker"

function bitmap(name: string) {
  return { close: () => undefined, name } as unknown as ImageBitmap
}

function nameOf(decoded: ImageBitmap) {
  return (decoded as unknown as { name: string }).name
}

class FakeWorker implements DecodeWorker {
  onerror: DecodeWorker["onerror"] = null
  onmessage: DecodeWorker["onmessage"] = null
  posted: DecodeRequest[] = []
  refuse = false
  terminated = false

  postMessage(message: DecodeRequest) {
    if (this.refuse) {
      throw new DOMException("not transferable", "DataCloneError")
    }

    this.posted.push(message)
  }

  terminate() {
    this.terminated = true
  }

  load() {
    this.emit({ ready: true })
  }

  reply(id: number, name: string) {
    this.emit({ bitmap: bitmap(name), id })
  }

  replyError(id: number, error: string) {
    this.emit({ error, id })
  }

  fail() {
    this.onerror?.({ message: "boom" } as ErrorEvent)
  }

  private emit(data: DecodeReply) {
    this.onmessage?.({ data } as MessageEvent<DecodeReply>)
  }
}

function harness({ spawnThrows = false } = {}) {
  const workers: FakeWorker[] = []
  const here: string[] = []
  const decoder = new ImageDecoder(
    () => {
      if (spawnThrows) {
        throw new Error("refused")
      }

      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
    async (_bytes, type) => {
      here.push(type)
      return bitmap(`here:${type}`)
    },
  )

  return { decoder, here, workers }
}

describe("ImageDecoder", () => {
  it("holds requests until the worker loads, then decodes there", async () => {
    const { decoder, here, workers } = harness()
    const a = decoder.decode(new ArrayBuffer(4), "image/png")
    const b = decoder.decode(new ArrayBuffer(4), "image/webp")

    expect(workers).toHaveLength(1)
    expect(workers[0]!.posted).toEqual([])

    workers[0]!.load()
    const [first, second] = workers[0]!.posted
    expect([first!.type, second!.type]).toEqual(["image/png", "image/webp"])

    workers[0]!.reply(second!.id, "b")
    workers[0]!.reply(first!.id, "a")
    expect(nameOf(await a)).toBe("a")
    expect(nameOf(await b)).toBe("b")
    expect(here).toEqual([])
  })

  it("passes on a decode the worker could not do", async () => {
    const { decoder, workers } = harness()
    const decoded = decoder.decode(new ArrayBuffer(4), "image/png")
    workers[0]!.load()
    workers[0]!.replyError(workers[0]!.posted[0]!.id, "bad image")

    await expect(decoded).rejects.toThrow("bad image")
  })

  it("decodes on this thread, for good, when the worker never loads", async () => {
    const { decoder, here, workers } = harness()
    const a = decoder.decode(new ArrayBuffer(4), "image/png")

    workers[0]!.fail()

    expect(nameOf(await a)).toBe("here:image/png")
    expect(workers[0]!.terminated).toBe(true)
    expect(nameOf(await decoder.decode(new ArrayBuffer(4), "image/webp")))
      .toBe("here:image/webp")
    expect(workers).toHaveLength(1)
    expect(here).toEqual(["image/png", "image/webp"])
  })

  it("decodes on this thread when no worker can be created", async () => {
    const { decoder, here } = harness({ spawnThrows: true })

    expect(nameOf(await decoder.decode(new ArrayBuffer(4), "image/png")))
      .toBe("here:image/png")
    expect(here).toEqual(["image/png"])
  })

  it("fails what a crashed worker held, then starts a fresh one", async () => {
    const { decoder, here, workers } = harness()
    const a = decoder.decode(new ArrayBuffer(4), "image/png")
    workers[0]!.load()
    workers[0]!.fail()

    await expect(a).rejects.toThrow("boom")

    const b = decoder.decode(new ArrayBuffer(4), "image/png")
    expect(workers).toHaveLength(2)
    expect(workers[1]!.posted).toEqual([])

    workers[1]!.load()
    workers[1]!.reply(workers[1]!.posted[0]!.id, "b")
    expect(nameOf(await b)).toBe("b")
    expect(here).toEqual([])
  })

  it("rejects a request it cannot post and keeps serving the rest", async () => {
    const { decoder, workers } = harness()
    const first = decoder.decode(new ArrayBuffer(4), "image/png")
    workers[0]!.refuse = true
    workers[0]!.load()

    await expect(first).rejects.toThrow("not transferable")

    workers[0]!.refuse = false
    const second = decoder.decode(new ArrayBuffer(4), "image/png")
    workers[0]!.reply(workers[0]!.posted[0]!.id, "b")
    expect(nameOf(await second)).toBe("b")
  })
})
