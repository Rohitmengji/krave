import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// public/sw.js runs in the browser's worker scope. Here it runs in a vm context with a
// Cache Storage double and a scripted network, so its routing and caching are testable.

const SOURCE = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "http://localhost:3005";

type WorkerRequest = { method: string; url: string; mode: string; headers: Headers };
type Network = (request: WorkerRequest) => Promise<Response>;
type WorkerEvent = {
  request?: WorkerRequest;
  respondWith?: (response: Promise<Response> | Response) => void;
  waitUntil: (work: Promise<unknown>) => void;
};

function request(url: string, init: { method?: string; mode?: string; headers?: HeadersInit } = {}) {
  return {
    method: init.method ?? "GET",
    url: new URL(url, ORIGIN).href,
    mode: init.mode ?? "no-cors",
    headers: new Headers(init.headers),
  };
}

const navigation = (url: string) => request(url, { mode: "navigate" });

/** A same-origin response, as the browser's fetch would report it. */
function reply(body: string, status = 200) {
  const response = new Response(body, { status });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

class CacheStorageDouble {
  readonly stores = new Map<string, Map<string, Response>>();

  private key(entry: string | { url: string }) {
    return new URL(typeof entry === "string" ? entry : entry.url, ORIGIN).href;
  }

  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, Response>();
    this.stores.set(name, store);
    return {
      put: async (entry: string | { url: string }, response: Response) => {
        // Matches the Cache API: a partial response cannot be stored.
        if (response.status === 206) throw new TypeError("Partial response");
        store.set(this.key(entry), response);
      },
      addAll: async () => {},
    };
  }

  async match(entry: string | { url: string }) {
    for (const store of this.stores.values()) {
      const hit = store.get(this.key(entry));
      if (hit) return hit.clone();
    }
    return undefined;
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }
}

function loadWorker(network: Network) {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const caches = new CacheStorageDouble();
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, listener: (event: WorkerEvent) => void) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(SOURCE, { self, caches, fetch: (r: WorkerRequest) => network(r), URL, Response, Headers, Set });

  const settle = async (pending: Promise<unknown>[]) => {
    await Promise.allSettled(pending);
    // Writes the worker did not hand to waitUntil still get to finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    caches,
    async fetch(req: WorkerRequest) {
      let responded: Promise<Response> | undefined;
      const pending: Promise<unknown>[] = [];
      listeners.get("fetch")!({
        request: req,
        respondWith: (response) => {
          responded = Promise.resolve(response);
        },
        waitUntil: (work) => pending.push(work),
      });
      if (!responded) return null;
      const response = await responded;
      await settle(pending);
      return response;
    },
    async activate() {
      const pending: Promise<unknown>[] = [];
      listeners.get("activate")!({ waitUntil: (work) => pending.push(work) });
      await settle(pending);
    },
  };
}

/** A network that answers from a script, then fails like an unplugged router. */
function scriptedNetwork(...answers: Array<Response | "offline">): Network {
  return async () => {
    const answer = answers.shift() ?? "offline";
    if (answer === "offline") throw new TypeError("Failed to fetch");
    return answer;
  };
}

describe("offline service worker", () => {
  it("serves the current build asset online even when an older copy is saved", async () => {
    const worker = loadWorker(scriptedNetwork(reply("bundle v1"), reply("bundle v2")));
    const chunk = request("/_next/static/chunks/src_app._.js");

    expect(await (await worker.fetch(chunk))!.text()).toBe("bundle v1");
    expect(await (await worker.fetch(chunk))!.text()).toBe("bundle v2");
  });

  it("falls back to the saved asset only when the network is down", async () => {
    const worker = loadWorker(scriptedNetwork(reply("bundle v1"), "offline"));
    const chunk = request("/_next/static/chunks/src_app._.js");

    await worker.fetch(chunk);
    expect(await (await worker.fetch(chunk))!.text()).toBe("bundle v1");
    expect((await worker.fetch(request("/_next/static/chunks/never-seen.js")))!.type).toBe("error");
  });

  it("leaves server component payloads, image optimisation and the API to the network", async () => {
    const worker = loadWorker(scriptedNetwork());

    for (const req of [
      request("/?_rsc=1x2y", { headers: { RSC: "1" } }),
      request("/restaurant/12", { headers: { RSC: "1", "Next-Router-Prefetch": "1" } }),
      request("/_next/image?url=%2Fdish.jpg&w=640&q=75"),
      request("/api/webroutes/orders"),
      navigation("/api/webroutes/orders"),
      request("/api/webroutes/orders", { method: "POST" }),
      request("https://images.example.com/dish.jpg"),
    ]) {
      expect(await worker.fetch(req), req.url).toBeNull();
    }
  });

  it("never keeps an error page or a partial response as the offline copy", async () => {
    const worker = loadWorker(
      scriptedNetwork(reply("storefront shell"), reply("Internal error", 500), reply("frag", 206)),
    );

    await worker.fetch(navigation("/"));
    expect((await worker.fetch(navigation("/orders")))!.status).toBe(500);
    expect((await worker.fetch(request("/_next/static/media/intro.mp4")))!.status).toBe(206);

    const offlineOrders = await worker.fetch(navigation("/orders"));
    expect(await offlineOrders!.text()).toBe("storefront shell");
    expect((await worker.fetch(request("/_next/static/media/intro.mp4")))!.type).toBe("error");
  });

  it("drops caches written by earlier worker versions when it activates", async () => {
    const worker = loadWorker(scriptedNetwork());
    const stale = await worker.caches.open("krave-shell-v1");
    await stale.put(`${ORIGIN}/?_rsc=old`, reply("stale payload"));

    await worker.activate();

    expect(await worker.caches.keys()).not.toContain("krave-shell-v1");
  });
});
