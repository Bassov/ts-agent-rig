#!/usr/bin/env node
import {
  DEFAULT_MUTATION_REPORT,
  runStrykerPrSummaryCli,
} from './stryker-pr-summary.mjs'

const argv = process.argv.slice(2)
process.exitCode = runStrykerPrSummaryCli(
  argv.length > 0 ? argv : [DEFAULT_MUTATION_REPORT],
  process.env,
)
