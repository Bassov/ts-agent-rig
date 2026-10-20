# `@albasov/ts-agent-rig`

Agent pipeline, roadmap CLI, and quality-gate harness for TypeScript / pnpm repos.

Host repos configure thresholds and check inventories in `quality/gates.json` and OpenSpec in `openspec/config.yaml`. The rig resolves the host root via `process.cwd()` / `quality/gates.json` walk / `git rev-parse` (override with `TS_RIG_REPO_ROOT`).

## Binaries

| Binary | Role |
| --- | --- |
| `agent` | `preflight`, `finish`, `instructions`, `review-brief`, `stats`, `manual-qa`, … |
| `roadmap` | Roadmap CLI |
| `ts-rig-check` | Parallel deterministic check runner (`pnpm check`) |
| `ts-rig-gate` | Gate subcommands (`pr-policy`, `gate-values`, `mutation-scope`, …) |
| `ts-rig-ci` | CI helpers (`report-comment`, `with-playwright-env`, …) |

## Programmatic

```js
import { loadGates } from '@albasov/ts-agent-rig/load-gates'
```

## Develop

```bash
pnpm test
pnpm test:pack-smoke
```

No Stryker on this package — Vitest + V8 coverage + pack-smoke only.

## GitHub Actions (host CI)

Pin by **git tag** (Actions are not in the npm tarball). Reusable workflows must
reference composites with a full `Bassov/ts-agent-rig/...@vX` ref — `./` resolves
against the *caller* repo, not this one.

```yaml
- uses: Bassov/ts-agent-rig/.github/actions/setup-node-pnpm@v0.2.1

- uses: Bassov/ts-agent-rig/.github/actions/report-section-pack@v0.2.1
  if: always()
  with:
    section: coverage
    step-outcome: ${{ steps.unit.outcome }}
    missing-report: job-failed
    report: coverage/coverage-summary.json
    body-file: /tmp/coverage-pr-comment.md
    artifact-name: ci-section-coverage

jobs:
  ci-comment:
    needs: checks
    if: always() && github.event_name == 'pull_request' && needs.checks.result != 'cancelled'
    uses: Bassov/ts-agent-rig/.github/workflows/ci-report-comment.yml@v0.2.1
    with:
      section: coverage
      artifact-name: ci-section-coverage
    secrets: inherit

  # Caller keeps pull_request_target trigger + concurrency:
  pr-policy:
    uses: Bassov/ts-agent-rig/.github/workflows/pr-policy.yml@v0.2.1
    secrets: inherit
```

| Path | Role |
| --- | --- |
| `.github/actions/setup-node-pnpm` | pnpm + Node + optional frozen install (no checkout) |
| `.github/actions/report-section-pack` | `ts-rig-ci report-comment pack` + upload artifact |
| `.github/workflows/ci-report-comment.yml` | Download artifact + `report-comment apply` |
| `.github/workflows/pr-policy.yml` | Base-only gate ratchet (`ts-rig-gate pr-policy`) |

## CI / tests

- `pnpm test` / `pnpm test:coverage` — fast unit + integration (`test/`).
- `pnpm test:pack-smoke` — pack + install into a temp host fixture.
- `pnpm test:host` — full lifted suite under `src/**/*.test.mjs` (expects a Photobooks-shaped host with `quality/gates.json`, roadmap, Stryker configs). Not run in this repo's GitHub Actions.
