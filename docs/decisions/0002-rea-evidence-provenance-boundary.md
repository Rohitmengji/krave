# ADR 0002: Separating Customer UI from Reverse-Engineering Telemetry and Provenance

## Status

Accepted

## Context

Early iterations surfaced raw reverse-engineering labels (`Redux: pages.search.SECTION_SEARCH_TABS`, `/webroutes/*` paths, and `zomato_get_dish_options(...)`) directly inside the consumer storefront and overstated synthetic Android APK artifacts.

## Decision

- Keep the primary storefront UI (`Navbar`, `KraveApp`, `RestaurantCardV2`, `RestaurantDetailModal`, `CartCheckoutDrawer`, `CrystalLiveTrackingModal`) strictly focused on customer-facing food delivery, table reservations, and brand customization.
- Isolate reverse-engineering bundle metadata and `window.zomato_webmcp` tool inspection inside the opt-in `ReaInspectorModal`.
- Mark Android APK analysis as `not-analyzed` in runtime metadata and document provenance boundaries in `rea-evidence/PROVENANCE.md` until an authorized genuine APK is analyzed.

## Consequences

- The storefront reads like a real consumer product without confusing developer jargon.
- Engineers can still inspect the captured web bundle AST metrics and invoke the reconstructed WebMCP tools on demand.
