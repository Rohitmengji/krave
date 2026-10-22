/**
 * Random identifiers that work in every browser context.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost). A terminal opened
 * over plain HTTP on a LAN address (`http://192.168.x.x:3005`) gets `undefined`, and calling
 * it throws. `crypto.getRandomValues` is available everywhere, so it is the fallback.
 */
export function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // RFC 9562 version 4 and variant bits, so the fallback is indistinguishable from randomUUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
