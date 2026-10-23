import { describe, expect, it } from "vitest";
import { securityHeaders, storageOrigin } from "@/lib/securityHeaders";

const imageHosts = [{ protocol: "https", hostname: "images.unsplash.com" }] as const;

function imgSrc(storageEndpoint?: string, isDev = false): string {
  const csp = securityHeaders({ isDev, imageHosts, storageEndpoint }).find(
    (header) => header.key === "Content-Security-Policy"
  )!.value;
  return csp.split("; ").find((directive) => directive.startsWith("img-src"))!;
}

describe("storage origin in the CSP", () => {
  it("allows presigned dish photos from the configured endpoint origin only", () => {
    expect(imgSrc("https://storage.example.neon.tech/some/path")).toBe(
      "img-src 'self' data: blob: https://images.unsplash.com https://storage.example.neon.tech"
    );
  });

  it("adds nothing when storage is unset or the endpoint is malformed", () => {
    expect(imgSrc(undefined)).toBe("img-src 'self' data: blob: https://images.unsplash.com");
    expect(imgSrc("not a url")).toBe("img-src 'self' data: blob: https://images.unsplash.com");
  });

  it("refuses plain http outside development", () => {
    expect(storageOrigin("http://localhost:9000", false)).toBeNull();
    expect(storageOrigin("http://localhost:9000", true)).toBe("http://localhost:9000");
    expect(storageOrigin("javascript:alert(1)", true)).toBeNull();
  });
});
