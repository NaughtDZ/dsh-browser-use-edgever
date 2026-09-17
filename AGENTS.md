# Repository Guidelines

## Project structure

We treat `src/` as the source of truth. `src/index.ts` exposes the Cordis plugin, `plugin-tools.ts` registers 16 browser operations, `browser-memory-tools.ts` registers four task/evidence tools, and `tool-schemas.ts` defines their schemas. Browser lifecycle code lives in `src/browser/manager.ts`; implementations are under `src/browser/operations/`, with CDP and DOM support in `src/browser/cdp/` and `src/browser/dom/`.

We keep unit and integration tests in `test/*.test.mjs`, real-browser and installation checks in `scripts/`, WebVoyager evaluation code in `scripts/eval/`, and the pinned 109-task dataset in `assets/benchmark/`. `cordis.patch.yml` connects the plugin to a DSH profile. We treat `lib/`, `node_modules/`, browser output, evaluation runs, and `.tgz` packages as generated artifacts.

## Build, test, and evaluation commands

- `npm install` installs development dependencies; Node.js 22.19 or newer is required.
- `npm run build` compiles the ESM package under `lib/`.
- `npm test` builds and runs all `node:test` suites.
- `npm run test:smoke` launches Chromium and covers the primary flow, dynamic/virtual lists, action postconditions, migration behavior, command errors, and checkpoint restoration.
- `npm run test:host` verifies the real Cordis/DSH Agent Loop and Chromium with deterministic model decisions.
- `npm run verify:package` and `npm run verify:installed` validate the package and a temporary consumer installation.
- `npm run eval:test` validates evaluation logic without a paid model request; `npm run eval:smoke` uses Chromium with deterministic model and Judge substitutes.
- `npm run eval -- --out output/evals/NAME --reasoning-effort high --concurrency 1 --headed --timeout 600000 --judge evidence` runs the real WebVoyager evaluator.

## Coding style

We use strict TypeScript, ESM imports with `.js` extensions, two-space indentation, double quotes, and no semicolons. We use `camelCase` for functions and variables, `PascalCase` for types and classes, and `browser_snake_case` for tool IDs. Schemas stay in `tool-schemas.ts`; configuration defaults and validation stay in `config.ts`. No formatter or linter is configured, so we match surrounding code and rely on the TypeScript build.

## Test and result contracts

We name tests `*.test.mjs` and describe observable behavior. New tools require registration/schema coverage and failure-path tests for approval, cancellation, timeouts, and cleanup. Browser, CDP, DOM, screenshot, navigation, or restoration changes require real-Chromium coverage in addition to unit tests.

We keep tool execution, checked postconditions, task completion, and benchmark scoring distinct. Expected action failures return `error`; incomplete checkpoint restores return `partial`. DOM coverage is revision-specific and never proves that every server-side item was read. WebVoyager `completed` means the Agent stopped normally; only `judge_result.pass` is a task success. Missing or unpriced usage remains unknown rather than being coerced to zero.

## Documentation and changes

We describe the project in owner voice and keep capability documentation current rather than appending dated update logs. `README.md` presents the product and verified benchmark result; `docs/evaluation.md`, `docs/reliability.md`, and `docs/evidence.md` define the detailed contracts. Generated evaluation reports must preserve their manifest, scoring mode, Trace provenance, and cost basis.

We follow Conventional Commit style, keep pull requests focused, explain user-visible effects, and list exact verification commands and results. Interaction changes include reproducible steps or screenshots when they materially help review.

## Security and configuration

We never commit cookies, credentials, page content, local browser profiles, private absolute paths, or real evaluation traces. We preserve Session-scoped browser isolation, propagate abort signals, and fail closed when required approval services are unavailable. Checkpoints stay in memory and exclude passwords and file selections. We report vulnerabilities through the private process in `SECURITY.md`, not a public issue.
