# Krave — Principal Engineer Quality Gate

You have already been given the Engineering Excellence master prompt. Now execute the next stage: bring the existing Krave application to a standard that would withstand a rigorous senior frontend engineer code review.

## Objective

Make the codebase understandable to a developer seeing it for the first time, robust enough for realistic user interactions, and documented well enough that another engineer can maintain it confidently.

Do not merely produce a report. Inspect the real files, implement justified improvements, run checks, and verify the outcome.

### 1. Review the application from the entry point

Trace the application through its actual execution flow:

- Next.js App Router entry points and layouts.
- KraveApp and its child components.
- Restaurant listings and detail views.
- Cart state and cartEngine.ts.
- Checkout and validation.
- Live tracking and related modal behavior.
- ReaInspector and brand customization features.
- API routes and external integrations.
- Loading, empty, error, and success states.

Follow actual imports and function calls. Do not assume that filenames accurately describe their behavior.

### 2. Improve readability without overengineering

For every file you change:

- Identify its responsibility and make that responsibility clear.
- Rename ambiguous functions and variables where beneficial.
- Extract domain logic from UI components where it improves testability.
- Reduce unnecessary nesting and repeated conditions.
- Remove genuinely dead code and unused dependencies.
- Preserve existing features and visual behavior.
- Avoid creating unnecessary hooks, providers, service layers, or utility files.

Every abstraction must solve a concrete problem.

### 3. Make comments valuable to future developers

Review existing comments and add missing documentation where it matters.

Explain:
- Why a business rule exists.
- Why state belongs in a particular module.
- Why an asynchronous operation needs cancellation or stale-response protection.
- Why a particular accessibility or performance technique is necessary.
- What assumptions an integration relies on.
- Which invariants must remain true.

Add concise TSDoc for non-obvious exported APIs.

Never write comments that simply repeat the code. Never invent historical context, business requirements, or performance claims.

### 4. Validate critical user flows

Inspect and test the following behavior where implemented:

- Adding, removing, and updating cart items.
- Handling zero, negative, fractional, invalid, and excessive quantities appropriately.
- Calculating totals consistently.
- Preventing invalid checkout submissions.
- Handling unavailable restaurants or failed requests.
- Preventing stale asynchronous results from overwriting newer state.
- Opening and closing dialogs and drawers.
- Keyboard navigation, focus management, and Escape behavior.
- Maintaining consistent state when navigating between views.

Distinguish between actual product requirements and assumptions. Do not impose arbitrary validation rules without evidence.

### 5. Audit Next.js and React implementation quality

Check that:

- Server Components are used where practical.
- Client Components are limited to interactive or browser-dependent functionality.
- Browser-only APIs are not accessed unsafely during server rendering.
- Effects have correct dependencies and cleanup.
- State is not duplicated unnecessarily.
- List keys are stable and meaningful.
- Memoization is justified.
- Error boundaries and route-level loading states are used where appropriate.
- External data is validated at relevant trust boundaries.
- API routes validate inputs and handle errors safely.
- Secrets are not exposed to client bundles.
- Dependency and rendering choices are consistent with the installed Next.js version.

Do not assume a specific Next.js API or version. Verify package.json and the installed conventions first.

### 6. Establish meaningful verification

Use the repository's existing tooling.

Run relevant available commands for:
- Linting.
- Type checking.
- Unit and integration tests.
- Production builds.
- Accessibility checks where supported.

Add focused tests for critical domain logic and regression-prone interactions when testing infrastructure exists or can be introduced without unnecessary complexity.

If a check cannot run, state why. Do not fabricate results or claim browser-based accessibility testing without actually performing it.

### 7. Improve documentation and onboarding

Ensure the repository provides accurate, practical guidance:

- README.md: purpose, prerequisites, setup, commands, architecture overview, and troubleshooting.
- CONTRIBUTING.md: coding conventions, tests, and pull request expectations.
- docs/architecture.md: module boundaries, rendering strategy, state ownership, data flow, and important trade-offs.
- docs/decisions/: short records for genuinely significant architectural decisions.

Include only information supported by the codebase. Avoid duplicating the same content across files.

### 8. Produce a reviewable final result

Work in small, coherent changes. After each meaningful change, review the diff and run relevant checks.

At completion, report:

1. Important issues discovered.
2. Files changed and why.
3. Architectural decisions and trade-offs.
4. Tests and commands actually run, with their results.
5. Accessibility and performance improvements verified.
6. Documentation added or updated.
7. Remaining risks and recommended next steps.

For every major improvement, explain:

**Problem → Approach → Implementation → Impact**

## Final quality gate

Before declaring the work complete, ask yourself:

- Would an experienced engineer understand this code without asking its author for clarification?
- Are the comments useful, accurate, and minimal?
- Can critical business logic be tested independently?
- Are the most important user flows covered by meaningful tests?
- Are accessibility and error handling implemented rather than merely documented?
- Can a new developer run the project using the README?
- Have all claimed improvements been verified?
- Is there any unnecessary complexity that should be removed?

Begin by inspecting the current repository and its actual state. Continue with verified, incremental improvements. Do not stop after presenting recommendations, and do not rewrite working features without a concrete reason.