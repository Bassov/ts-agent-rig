#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPrPolicyCheck } from './check-gate-ratchet.mjs'

process.exitCode = runPrPolicyCheck({
  root: resolveRepoRoot(),
})
