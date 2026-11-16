import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ImageMimeType } from './dish-models.js';
import type { DecodedImage, ImageDecoder } from '../ports/image-decoder.js';

export type ImageDecodeErrorKind = 'invalid' | 'unsupported' | 'resource';

export class ImageDecodeError extends Error {
  constructor(public readonly kind: ImageDecodeErrorKind) {
    super(`image decode failed: ${kind}`);
    this.name = 'ImageDecodeError';
  }
}

interface DecodeTask {
  id: number;
  body: Buffer;
  resolve(value: DecodedImage): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

interface WorkerSlot {
  child: ChildProcess;
  status: 'starting' | 'idle' | 'busy' | 'dead';
  task: DecodeTask | null;
}

interface WorkerMessage {
  id?: number;
  ok?: boolean;
  mimeType?: ImageMimeType;
  kind?: ImageDecodeErrorKind;
}

const WORKER_COUNT = 2;
const QUEUE_LIMIT = 8;
const TASK_TIMEOUT_MS = 10_000;
const RSS_LIMIT_BYTES = 512 * 1024 * 1024;

function workerPath(): { path: string; execArgv: string[] } {
  if (fileURLToPath(import.meta.url).endsWith('.ts')) {
    return {
      path: fileURLToPath(new URL('./image-decoder-child.ts', import.meta.url)),
      execArgv: ['--import', 'tsx'],
    };
  }
  return { path: fileURLToPath(new URL('./image-decoder-child.js', import.meta.url)), execArgv: [] };
}

export class ImageDecoderPool implements ImageDecoder {
  private readonly workers: WorkerSlot[] = [];
  private readonly queue: DecodeTask[] = [];
  private nextTaskId = 1;
  private starting: Promise<void> | null = null;
  private closed = false;
  private watchdog: NodeJS.Timeout | null = null;

  hasCapacity(): boolean {
    return !this.closed && this.queue.length < QUEUE_LIMIT;
  }

  async decode(body: Buffer): Promise<DecodedImage> {
    if (this.closed) throw new ImageDecodeError('resource');
    await this.ensureWorkers();
    if (this.closed) throw new ImageDecodeError('resource');
    if (!this.hasCapacity()) throw new ImageDecodeError('resource');

    const idle = this.workers.find((worker) => worker.status === 'idle');
    if (!idle && this.queue.length >= QUEUE_LIMIT) throw new ImageDecodeError('resource');

    return new Promise<DecodedImage>((resolve, reject) => {
      const task: DecodeTask = { id: this.nextTaskId++, body, resolve, reject };
      this.queue.push(task);
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    const error = new ImageDecodeError('resource');
    for (const task of this.queue.splice(0)) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(error);
    }
    for (const worker of this.workers) {
      if (worker.task) {
        if (worker.task.timer) clearTimeout(worker.task.timer);
        worker.task.reject(error);
        worker.task = null;
      }
      worker.status = 'dead';
      worker.child.kill('SIGKILL');
    }
    this.workers.length = 0;
  }

  private ensureWorkers(): Promise<void> {
    if (this.workers.length >= WORKER_COUNT) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = (async () => {
      try {
        let consecutiveFailures = 0;
        while (!this.closed && this.workers.length < WORKER_COUNT) {
          try {
            await this.spawnWorker();
            consecutiveFailures = 0;
          } catch {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 2) break;
          }
        }
        if (this.workers.length === 0) throw new ImageDecodeError('resource');
        this.startWatchdog();
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private spawnWorker(): Promise<void> {
    const executable = workerPath();
    let child: ChildProcess;
    try {
      child = fork(executable.path, [], {
        execArgv: [...executable.execArgv, '--max-old-space-size=256'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch {
      return Promise.reject(new ImageDecodeError('resource'));
    }

    const worker: WorkerSlot = { child, status: 'starting', task: null };
    this.workers.push(worker);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once('spawn', () => {
        settled = true;
        if (this.closed) {
          child.kill('SIGKILL');
          reject(new ImageDecodeError('resource'));
          return;
        }
        worker.status = 'idle';
        resolve();
        this.pump();
      });
      child.once('error', () => {
        if (!settled) {
          settled = true;
          reject(new ImageDecodeError('resource'));
        }
        this.handleWorkerFailure(worker, 'resource', false);
      });
      child.on('message', (message: WorkerMessage) => this.handleMessage(worker, message));
      child.once('exit', () => this.handleWorkerFailure(worker, 'resource', true));
    });
  }

  private handleMessage(worker: WorkerSlot, message: WorkerMessage): void {
    const task = worker.task;
    if (!task || message.id !== task.id || worker.status !== 'busy') return;
    if (task.timer) clearTimeout(task.timer);
    worker.task = null;
    worker.status = 'idle';

    if (message.ok && message.mimeType) {
      task.resolve({ mimeType: message.mimeType });
    } else {
      task.reject(new ImageDecodeError(message.kind ?? 'invalid'));
    }
    this.pump();
  }

  private handleWorkerFailure(worker: WorkerSlot, kind: ImageDecodeErrorKind, replace: boolean): void {
    if (worker.status === 'dead') return;
    worker.status = 'dead';
    if (worker.task) {
      if (worker.task.timer) clearTimeout(worker.task.timer);
      worker.task.reject(new ImageDecodeError(kind));
      worker.task = null;
    }
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    if (!worker.child.killed) worker.child.kill('SIGKILL');

    if (replace && !this.closed && this.workers.length < WORKER_COUNT && !this.starting) {
      void this.ensureWorkers().catch(() => undefined);
    }
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const worker = this.workers.find((candidate) => candidate.status === 'idle');
      if (!worker) return;
      const task = this.queue.shift()!;
      worker.status = 'busy';
      worker.task = task;
      task.timer = setTimeout(() => {
        this.handleWorkerFailure(worker, 'resource', true);
      }, TASK_TIMEOUT_MS);

      worker.child.send({ type: 'decode', id: task.id, data: task.body }, (error) => {
        if (error) this.handleWorkerFailure(worker, 'resource', true);
      });
    }
  }

  private startWatchdog(): void {
    if (this.watchdog || this.closed) return;
    this.watchdog = setInterval(() => {
      for (const worker of this.workers) {
        if (worker.status !== 'busy' || !worker.child.pid) continue;
        try {
          const status = readFileSync(`/proc/${worker.child.pid}/status`, 'utf8');
          const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
          if (match && Number(match[1]) * 1024 > RSS_LIMIT_BYTES) {
            this.handleWorkerFailure(worker, 'resource', true);
          }
        } catch {
          // A process that disappears is handled by the exit listener.
        }
      }
    }, 50);
    this.watchdog.unref();
  }
}
