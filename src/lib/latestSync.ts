/**
 * Sends the latest value of something a user can change faster than the network answers
 * (a bookmark list, a membership switch).
 *
 * Firing one request per click lets the server receive them out of order and keep an older
 * value. Here only one request is in flight at a time, and values that arrive meanwhile
 * collapse to the newest, so the server always ends on the user's last choice.
 */
export interface LatestSync<T> {
  /** Resolves or rejects with the request that carries this value (or a newer one). */
  push: (value: T) => Promise<void>;
  /**
   * Drop a value still waiting to be sent, because the session it belonged to has ended.
   * Its callers resolve without a request; one already in flight is not recalled.
   */
  discard: () => void;
}

export function createLatestSync<T>(send: (value: T) => Promise<void>): LatestSync<T> {
  let busy = false;
  let queued: {
    value: T;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;

  function start(value: T): Promise<void> {
    busy = true;
    const request = Promise.resolve()
      .then(() => send(value))
      .finally(() => {
        busy = false;
        const next = queued;
        queued = null;
        if (next) start(next.value).then(next.resolve, next.reject);
      });
    return request;
  }

  return {
    push(value) {
      if (!busy) return start(value);
      if (queued) {
        queued.value = value;
        return queued.promise;
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      queued = { value, promise, resolve, reject };
      return promise;
    },
    discard() {
      const dropped = queued;
      queued = null;
      dropped?.resolve();
    },
  };
}
