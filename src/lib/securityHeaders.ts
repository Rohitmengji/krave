type Header = { key: string; value: string };
type RemotePattern = { protocol?: string; hostname: string };

/**
 * App-wide response headers.
 *
 * The CSP is static rather than nonce-based: a nonce forces every page to render per
 * request, which would undo the prerendered restaurant pages. Inline scripts therefore
 * stay allowed (Next's bootstrap needs them); the policy still blocks plugins, <base>
 * hijacking, framing, form hijacking, and any fetch or image load to a host not listed.
 */
export function securityHeaders({
  isDev,
  imageHosts,
}: {
  isDev: boolean;
  imageHosts: readonly RemotePattern[];
}): Header[] {
  const images = imageHosts.map(({ protocol = "https", hostname }) => `${protocol}://${hostname}`);
  const csp = [
    "default-src 'self'",
    // React rebuilds server error stacks with eval in development only.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...images].join(" "),
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Browsers ignore it over plain http, so local development is unaffected.
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    // Location stays available to this origin for the address picker; nothing else is.
    {
      key: "Permissions-Policy",
      value: "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()",
    },
  ];
}
