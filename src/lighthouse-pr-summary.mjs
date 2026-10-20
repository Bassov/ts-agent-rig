#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '.lighthouseci'
const outcome = process.env.LHCI_OUTCOME ?? 'unknown'

const lines = ['## Lighthouse CI', '']

if (!existsSync(dir)) {
  lines.push(`No \`.lighthouseci/\` output (job outcome: **${outcome}**).`, '')
} else {
  const lhrFiles = readdirSync(dir)
    .filter((name) => /^lhr-.*\.json$/.test(name))
    .map((name) => join(dir, name))
    .sort()

  const latest = lhrFiles.at(-1)
  if (latest) {
    const lhr = JSON.parse(readFileSync(latest, 'utf8'))
    const cats = lhr.categories ?? {}
    const pct = (score) =>
      typeof score === 'number' ? `${Math.round(score * 100)}` : '—'

    lines.push(
      `| Category | Score |`,
      `| --- | --- |`,
      `| Performance | ${pct(cats.performance?.score)} |`,
      `| Accessibility | ${pct(cats.accessibility?.score)} |`,
      `| Best Practices | ${pct(cats['best-practices']?.score)} |`,
      `| SEO | ${pct(cats.seo?.score)} |`,
      `| Budgets | **${outcome === 'success' ? 'passed' : 'failed / errored'}** |`,
      '',
    )
  } else {
    lines.push(
      `Budgets: **${outcome === 'success' ? 'passed' : 'failed / errored'}**`,
      '',
    )
  }

  const linksPath = join(dir, 'links.json')
  if (existsSync(linksPath)) {
    const links = JSON.parse(readFileSync(linksPath, 'utf8'))
    const urls = Object.values(links).filter((u) => typeof u === 'string')
    if (urls.length > 0) {
      lines.push('### Report links', '')
      for (const url of urls) {
        lines.push(`- [Open Lighthouse HTML report](${url})`)
      }
      lines.push('')
    }
  }
}

const markdown = lines.join('\n')
process.stdout.write(markdown)

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  appendFileSync(summaryPath, markdown)
}
