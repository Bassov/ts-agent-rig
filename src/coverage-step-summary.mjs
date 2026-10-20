#!/usr/bin/env node
import { readFileSync, existsSync, appendFileSync } from 'node:fs'

const summaryPath = 'coverage/coverage-summary.json'
if (!existsSync(summaryPath)) {
  const note = `No coverage summary at \`${summaryPath}\` (coverage step may have been skipped).\n`
  process.stdout.write(note)
  const ghSummary = process.env.GITHUB_STEP_SUMMARY
  if (ghSummary) {
    appendFileSync(ghSummary, `## Coverage\n\n${note}`)
  }
  process.exit(0)
}

const data = JSON.parse(readFileSync(summaryPath, 'utf8'))
const total = data.total
const fmt = (m) => `${m.pct}% (${m.covered}/${m.total})`

const markdown = [
  '## Coverage',
  '',
  `| Metric | Value |`,
  `| --- | --- |`,
  `| Statements | ${fmt(total.statements)} |`,
  `| Branches | ${fmt(total.branches)} |`,
  `| Functions | ${fmt(total.functions)} |`,
  `| Lines | ${fmt(total.lines)} |`,
  '',
].join('\n')

process.stdout.write(markdown)

const ghSummary = process.env.GITHUB_STEP_SUMMARY
if (ghSummary) {
  appendFileSync(ghSummary, markdown)
}
