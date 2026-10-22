# Contributing

Use the locked npm dependencies and keep domain rules independent of React.
Keep changes small and preserve the existing public UI unless a concrete defect
or requirement justifies changing it. Do not add state frameworks for convenience.

For checkout changes, test malformed inputs, catalog-based pricing, modifier
constraints, empty carts, quantity boundaries, and failed requests. Reproduce
the browser flow: add a dish, customize, checkout, refresh, track, and reorder.
Check desktop and narrow mobile viewports and keyboard dismissal/focus behavior.

Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` before handing
off changes. Run `npm run test:e2e` for anything touching checkout, accounts, or the
terminal; it builds nothing itself, so run `npm run build` first. Run `npm audit --omit=dev`
after dependency changes, and plain `npm audit` too: both are expected to report zero.
Document test failures and unavailable checks explicitly.

The browser suite runs against a production build on port 3099 with a throwaway database
under `.data-e2e/`, so it never touches `.data/`. It runs single-worker on purpose: the
specs share one terminal floor and one account store, and parallel runs would interleave.
Prefer adding a case there over asserting a flow by hand — every bug found during this
project's build was caught in a browser, not by a unit test.

`eslint-config-next` is deliberately not installed. It pulls
`@next/eslint-plugin-next -> fast-glob -> micromatch -> braces`, and the current braces
advisory (GHSA-vfj7-8cjw-p6xm) covers every published version, so there is nothing to
upgrade or override to. The lint stack is `eslint` + `@eslint/js` + `typescript-eslint`,
which keeps both audits clean; `next build` still catches Next-specific problems. Do not
re-add it without checking whether braces has shipped a fix.

Never describe a mock, inferred contract, seeded review, or synthetic artifact as
an authenticated integration or verified property of the original app. REA hashes
identify the supplied bytes, not their legitimacy. See the evidence provenance
note before using or extending existing analysis. Only inspect authorized targets.