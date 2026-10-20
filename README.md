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
