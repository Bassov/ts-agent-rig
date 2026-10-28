# `@albasov/ts-agent-rig`

Agent pipeline, roadmap CLI, and quality-gate harness for TypeScript / pnpm repos.

Host repos configure thresholds and check inventories in `quality/gates.json` and OpenSpec in `openspec/config.yaml`. The rig resolves the host root via `process.cwd()` / `quality/gates.json` walk / `git rev-parse` (override with `TS_RIG_REPO_ROOT`).

Host procedural SoT for the agent loop (stages, A/B/C, commit rules, stamp, thin finish) is `docs/agent-loop.md`. Preflight run-card APPLY/PREP procedures point there instead of inlining finish/stamp recipes.

## Binaries

| Binary | Role |
| --- | --- |
| `agent` | `preflight`, `finish`, `finalize`, `ci-brief`, `ci-wait`, `instructions`, `review-brief`, `stats`, `manual-qa`, … |
| `roadmap` | Roadmap CLI |
| `ts-rig-check` | Parallel deterministic check runner (`pnpm check`) |
| `ts-rig-gate` | Gate subcommands (`pr-policy`, `gate-values`, `mutation-scope`, …) |
| `ts-rig-ci` | CI helpers (`report-comment`, `with-playwright-env`, …) |

`ts-rig-check` / `pnpm check` defaults to the **fast** inventory (A): `checks.core` minus integrity members (`openspec-budget`, `codecov-yml`, `roadmap`), with `afterUnit` minus `stryker-diff`. Pass `--inventory integrity` (or `CHECK_INVENTORY=integrity`) for C1-only gates; `--inventory core` keeps the legacy full core+afterUnit wave. Hosts may set explicit `checks.fast` / `checks.integrity` arrays in `quality/gates.json`.

Lefthook pre-push: `ts-rig-ci hook-pre-push` runs `pnpm check:integrity && pnpm check:fast`, except when `AGENT_THIN_FINISH=1` (set by `agent finish` on `git push`) **and** the stage-11 green-tree stamp is current — then it skips both. Hand-push never sets that env, so it always pays A+C1. Never use `--no-verify`.

### `agent ci-wait`

Polls the PR for the current branch (`gh`) until checks settle (default timeout 45m; `--timeout <minutes>`, `--pr N`). Ignores `codecov/patch` and skipped checks. Prints `OK` (exit 0) when the rest pass; otherwise prints failed job names plus a truncated failed-log tail (~80 lines each) and exits non-zero.

### Patch-coverage base

Local `ts-rig-gate patch-coverage` / `check-patch-coverage` always scores against the branch base = merge-base with `origin/main` (same as Codecov). The phase-commit `STRYKER_DIFF_BASE` applies only to `e2e:changed` and `stryker:diff`, not patch coverage.

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
