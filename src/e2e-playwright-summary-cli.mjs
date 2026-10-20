#!/usr/bin/env node
import { main } from './e2e-playwright-summary.mjs'

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
