# Real finalize failures (photobooks workers, 2026-11-04 … 11-14)

Verbatim `pnpm agent finalize` outputs (v0.2.22) replayed by
`src/finalize-replay.test.mjs`. Self-check cases hold the `quality:self-check`
output under the `FAIL quality:self-check` header; `error:` cases are the
thrown messages. Home paths are scrubbed to `/work/`.

| File                                  | Worker                     | Share of 171 calls       |
| ------------------------------------- | -------------------------- | ------------------------ |
| `1-evidence-leftover.txt`             | design-r28-hosting         | 96 (+2 piped)            |
| `2-ratchet-test-file-deleted.txt`     | cover-editor               | 24 with ratchet findings |
| `3-disables-nocoverage.txt`           | printer-presets            | 3                        |
| `5-delta-sync.txt`                    | connect-own-hosting-core   | 19                       |
| `6-dirty-tree.txt`                    | connect-own-hosting-core   | 26                       |
| `7-ratchet-agent-rules-over-budget.txt` | code-scout-agent         | in the 24 above          |
