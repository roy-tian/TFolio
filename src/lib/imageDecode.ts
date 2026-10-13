import type { DecodeReply, DecodeRequest } from "@/lib/imageDecodeWorker"

type Request = {
  bytes: ArrayBuffer
  reject: (error: Error) => void
  resolve: (bitmap: ImageBitmap) => void
  type: string
}

/** The part of a `Worker` the decoder uses. */
export type DecodeWorker = Pick<Worker, "postMessage" | "terminate"> & {
  onerror: ((event: ErrorEvent) => void) | null
  onmessage: ((event: MessageEvent<DecodeReply>) => void) | null
}

function spawnDecodeWorker(): DecodeWorker {
  return new Worker(new URL("./imageDecodeWorker.ts", import.meta.url), {
    type: "module",
  })
}

function decodeOnThisThread(bytes: ArrayBuffer, type: string) {
  return createImageBitmap(new Blob([bytes], { type }))
}

/**
 * Decodes encoded images off the main thread. WebKitGTK decodes
 * `createImageBitmap` on the calling thread, stalling scrolling by 30–270 ms
 * per page there.
 */
export class ImageDecoder {
  private readonly decodeHere: (bytes: ArrayBuffer, type: string) => Promise<ImageBitmap>
  private failed = false
  private nextId = 0
  private readonly pending = new Map<number, Request>()
  private readonly queued: Request[] = []
  private ready = false
  private readonly spawn: () => DecodeWorker
  private worker: DecodeWorker | null = null

  constructor(spawn = spawnDecodeWorker, decodeHere = decodeOnThisThread) {
    this.decodeHere = decodeHere
    this.spawn = spawn
  }

  /** Takes ownership of `bytes`. */
  decode(bytes: ArrayBuffer, type: string): Promise<ImageBitmap> {
    if (this.failed) {
      return this.decodeHere(bytes, type)
    }

    return new Promise<ImageBitmap>((resolve, reject) => {
      const request = { bytes, reject, resolve, type }

      if (!this.worker) {
        this.start()
      }

      if (this.failed) {
        this.runHere(request)
      } else if (this.ready) {
        this.send(request)
      } else {
        this.queued.push(request)
      }
    })
  }

  private start() {
    let worker: DecodeWorker

    try {
      worker = this.spawn()
    } catch {
      this.fallBack()
      return
    }

    worker.onmessage = ({ data }) => {
      if ("ready" in data) {
        this.ready = true

        for (const request of this.queued.splice(0)) {
          this.send(request)
        }

        return
      }

      const request = this.pending.get(data.id)
      this.pending.delete(data.id)

      if ("bitmap" in data) {
        if (request) {
          request.resolve(data.bitmap)
        } else {
          data.bitmap.close()
        }
      } else {
        request?.reject(new Error(data.error))
      }
    }
    // Before "ready" the worker never loaded, as where an engine or the CSP
    // refuses it: decoding here stalls, but renders. After, it crashed: fail
    // what it held, and let the next request start a fresh one.
    worker.onerror = (event) => {
      worker.terminate()
      this.worker = null

      if (!this.ready) {
        this.fallBack()
        return
      }

      this.ready = false

      for (const request of this.pending.values()) {
        request.reject(new Error(event.message || "The image decoder failed"))
      }

      this.pending.clear()
    }
    this.worker = worker
  }

  private fallBack() {
    this.failed = true

    for (const request of this.queued.splice(0)) {
      this.runHere(request)
    }
  }

  private runHere(request: Request) {
    this.decodeHere(request.bytes, request.type).then(
      request.resolve,
      request.reject,
    )
  }

  private send(request: Request) {
    const id = this.nextId
    this.nextId += 1

    try {
      this.worker!.postMessage(
        { bytes: request.bytes, id, type: request.type } satisfies DecodeRequest,
        [request.bytes],
      )
    } catch (error) {
      request.reject(error as Error)
      return
    }

    // Registered after posting so a post that throws leaves no entry behind;
    // the reply always arrives in a later task.
    this.pending.set(id, request)
  }
}

/** One per window, its worker started by the first page that needs it. */
const imageDecoder = new ImageDecoder()

export function decodeImage(bytes: ArrayBuffer, type: string) {
  return imageDecoder.decode(bytes, type)
}
