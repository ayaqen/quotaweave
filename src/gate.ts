import { QuotaWeaveScheduler } from "./scheduler.js";
import type {
  ScheduledLease,
  SchedulerOptions,
  SchedulerSnapshot,
  Settlement,
  WorkItem,
} from "./types.js";

interface Waiter<TPayload> {
  readonly resolve: (lease: ScheduledLease<TPayload>) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbortListener: () => void;
}

/**
 * Promise-based admission gate for one process. Distributed adapters can use
 * the same scheduler contract while storing queues and leases externally.
 */
export class InMemoryQuotaGate<TPayload = unknown> {
  readonly #scheduler: QuotaWeaveScheduler<TPayload>;
  readonly #waiters = new Map<string, Waiter<TPayload>>();

  public constructor(options: SchedulerOptions | QuotaWeaveScheduler<TPayload>) {
    this.#scheduler = options instanceof QuotaWeaveScheduler
      ? options
      : new QuotaWeaveScheduler<TPayload>(options);
  }

  public acquire(item: WorkItem<TPayload>, signal?: AbortSignal): Promise<ScheduledLease<TPayload>> {
    if (signal?.aborted === true) return Promise.reject(abortError(item.id));

    return new Promise<ScheduledLease<TPayload>>((resolve, reject) => {
      const onAbort = (): void => {
        this.#scheduler.cancel(item.id);
        this.#waiters.delete(item.id);
        reject(abortError(item.id));
        this.#pump();
      };
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });

      this.#waiters.set(item.id, {
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      });

      try {
        this.#scheduler.enqueue(item);
        this.#pump();
      } catch (error) {
        const waiter = this.#waiters.get(item.id);
        waiter?.removeAbortListener();
        this.#waiters.delete(item.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public settle(lease: ScheduledLease<TPayload>, settlement: Settlement = {}): void {
    this.#scheduler.settle(lease.leaseId, lease.fencingToken, settlement);
    this.#pump();
  }

  public renew(
    lease: ScheduledLease<TPayload>,
    extensionMs?: number,
  ): ScheduledLease<TPayload> {
    return this.#scheduler.renew(lease.leaseId, lease.fencingToken, extensionMs);
  }

  public sweepExpired(now?: number): readonly ScheduledLease<TPayload>[] {
    const expired = this.#scheduler.sweepExpired(now);
    this.#pump();
    return expired;
  }

  public snapshot(): SchedulerSnapshot {
    return this.#scheduler.snapshot();
  }

  public get scheduler(): QuotaWeaveScheduler<TPayload> {
    return this.#scheduler;
  }

  #pump(): void {
    const queued = this.#scheduler.snapshot().queued;
    if (queued === 0) return;
    for (const lease of this.#scheduler.schedule(queued)) {
      const waiter = this.#waiters.get(lease.item.id);
      if (waiter === undefined) continue;
      this.#waiters.delete(lease.item.id);
      waiter.removeAbortListener();
      waiter.resolve(lease);
    }
  }
}

function abortError(itemId: string): Error {
  const error = new Error(`Admission for work item '${itemId}' was aborted.`);
  error.name = "AbortError";
  return error;
}
