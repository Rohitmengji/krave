// Offline shell for the storefront and the dine-in terminal.
//
// Network-first for everything it handles: online, the page always gets what the server
// has now, and the saved copy is used only when the network fails. Hashed production
// assets still come out of the HTTP cache, so this costs nothing. Cache-first would keep
// serving an old bundle after a deploy, and in development, where chunk names are not
// content hashed, it would hide every edit.
//
// Only page navigations and build assets are handled. Everything else goes straight to
// the network: API calls (a stale order confirmation must never be replayed), React Server
// Component payloads (they carry menus and prices), image optimisation and dev tooling.

// Bumping the version drops every older cache on activate. v1 saved RSC payloads and
// error pages, so it must not survive.
const CACHE = "krave-shell-v2";
const SHELL = ["/", "/pos", "/manifest.webmanifest", "/icon.svg"];
const STATIC_FILES = new Set(["/manifest.webmanifest", "/icon.svg"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(request, url) {
  if (url.pathname.startsWith("/api/")) return false;
  if (request.mode === "navigate") return true;
  if (request.headers.has("RSC") || url.searchParams.has("_rsc")) return false;
  return url.pathname.startsWith("/_next/static/") || STATIC_FILES.has(url.pathname);
}

async function networkFirst(event, request) {
  try {
    const response = await fetch(request);
    // Only a complete same-origin success is worth replaying offline: an error page must
    // not become the offline copy, and the Cache API rejects partial (206) responses.
    if (response.status === 200 && response.type === "basic") {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {}));
    }
    return response;
  } catch {
    const saved = await caches.match(request);
    if (saved) return saved;
    if (request.mode === "navigate") return (await caches.match("/")) || Response.error();
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!isShellRequest(request, url)) return;

  event.respondWith(networkFirst(event, request));
});
