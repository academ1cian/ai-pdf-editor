export class PDFClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private ready = false;
  private stopped = false;
  private queued: unknown[] = [];
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.onmessage = ({ data }) => {
      if (data.ready) {
        this.ready = true;
        for (const message of this.queued) this.worker.postMessage(message);
        this.queued = [];
        return;
      }
      const entry = this.pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    };
    this.worker.onerror = () =>
      this.stop('The PDF processor stopped. Reopen your original file to continue.');
  }
  request<T>(type: string, payload?: unknown): Promise<T> {
    if (this.stopped)
      return Promise.reject(new Error('The PDF processor stopped. Reopen your original file.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(
        () =>
          this.stop(
            'Processing exceeded 45 seconds. Your source file is unchanged; reopen a smaller document.',
          ),
        45000,
      );
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const message = { id, type, payload };
      if (this.ready) this.worker.postMessage(message);
      else this.queued.push(message);
    });
  }
  get closed() {
    return this.stopped;
  }
  private stop(message: string) {
    this.stopped = true;
    this.worker.terminate();
    this.queued = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  destroy() {
    this.stop('Editor closed.');
  }
}
