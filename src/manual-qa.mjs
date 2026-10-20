#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/** Headless manual QA: Playwright Chromium, 4× CPU throttle, LoAF counting. */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  MANUAL_QA_CPU_THROTTLE,
  parseManualScenarios,
} from './manual-qa-scenarios.mjs'

export { MANUAL_QA_CPU_THROTTLE, parseManualScenarios }

const nodeRequire = createRequire(import.meta.url)
const ROOT = resolveRepoRoot()

export function loadScenarioSources(root, slug) {
  /** @type {string[]} */
  const chunks = []
  if (!slug) return ''
  const base = path.join(root, 'docs', 'roadmap')
  if (fs.existsSync(base)) {
    for (const mil of fs.readdirSync(base, { withFileTypes: true })) {
      if (!mil.isDirectory()) continue
      const f = path.join(base, mil.name, `${slug}.md`)
      if (fs.existsSync(f)) chunks.push(fs.readFileSync(f, 'utf8'))
    }
  }
  const tasks = path.join(root, 'openspec', 'changes', slug, 'tasks.md')
  if (fs.existsSync(tasks)) chunks.push(fs.readFileSync(tasks, 'utf8'))
  return chunks.join('\n')
}

/** @param {Record<string, unknown>} [opts] */
export async function runManualQa(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  const slug = /** @type {string | undefined} */ (opts.slug)
  const fromMd = parseManualScenarios(loadScenarioSources(root, slug))
  const scenarios = /** @type {string[] | undefined} */ (opts.scenarios)?.length
    ? /** @type {string[]} */ (opts.scenarios)
    : fromMd.length
      ? fromMd
      : ['smoke: branded editor shell shows Photobooks']

  let baseURL = /** @type {string | undefined} */ (opts.baseUrl)
  /** @type {import('node:child_process').ChildProcess | null} */
  let preview = null
  if (!baseURL) {
    const port = String(process.env.E2E_PORT || '4173')
    baseURL = `http://127.0.0.1:${port}`
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `fetch(${JSON.stringify(baseURL)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    if (probe.status !== 0) {
      if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
        const build = spawnSync('pnpm', ['build'], {
          cwd: root,
          encoding: 'utf8',
          env: process.env,
        })
        if (build.status !== 0) {
          return {
            ok: false,
            lines: ['1. bootstrap: expected / observed — pnpm build failed'],
          }
        }
      }
      preview = spawn(
        'pnpm',
        ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', port],
        {
          cwd: root,
          env: process.env,
          stdio: 'ignore',
        },
      )
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  /** @type {string[]} */
  const lines = []
  /** @type {string[]} */
  const problems = []
  try {
    const { chromium } = nodeRequire('playwright')
    const browser = await chromium.launch({
      headless: true,
      executablePath: opts.chromiumPath || process.env.CHROME_PATH || undefined,
    })
    const page = await browser.newPage()
    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setCPUThrottlingRate', {
      rate: MANUAL_QA_CPU_THROTTLE,
    })

    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i]
      const isPerf = /^perf:/i.test(scenario)
      try {
        await page.goto(`${baseURL}/?perf=1`, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(300)
        if (
          await page
            .getByTestId('home-screen')
            .isVisible()
            .catch(() => false)
        ) {
          const start = page.getByTestId('start-session')
          if (await start.isVisible().catch(() => false)) {
            await start.click()
            await page
              .getByTestId('editor-shell')
              .waitFor({ state: 'visible', timeout: 15000 })
          }
        }
        if (
          !(await page
            .getByTestId('editor-shell')
            .isVisible()
            .catch(() => false))
        ) {
          problems.push(
            `${i + 1}. ${scenario}: expected editor-shell visible / observed missing`,
          )
          continue
        }
        if (isPerf) {
          await page.evaluate(() =>
            window.__photobooksPerf?.clearLoafEntries?.(),
          )
          await page.mouse.wheel(0, 400)
          await page.waitForTimeout(500)
          const loaf = await page.evaluate(
            () => window.__photobooksPerf?.getLoafEntries?.()?.length ?? -1,
          )
          if (loaf > 0) {
            problems.push(
              `${i + 1}. ${scenario}: expected 0 LoAF / observed ${loaf}`,
            )
            continue
          }
          if (loaf < 0) {
            problems.push(
              `${i + 1}. ${scenario}: expected __photobooksPerf LoAF API / observed missing`,
            )
            continue
          }
        }
        const brand = await page
          .getByText('Photobooks')
          .first()
          .isVisible()
          .catch(() => false)
        if (!brand && /photobooks|brand|shell/i.test(scenario)) {
          problems.push(
            `${i + 1}. ${scenario}: expected Photobooks brand / observed missing`,
          )
          continue
        }
        lines.push(`OK ${scenario}`)
      } catch (err) {
        problems.push(
          `${i + 1}. ${scenario}: expected pass / observed ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await browser.close()
  } catch (err) {
    problems.push(
      `1. playwright: expected launch / observed ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (preview?.pid) {
      try {
        process.kill(preview.pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }
  return problems.length ? { ok: false, lines: problems } : { ok: true, lines }
}

export async function main(argv = process.argv.slice(2)) {
  let slug
  let baseUrl
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--change' || argv[i] === '--slug') slug = argv[++i]
    else if (argv[i] === '--base-url') baseUrl = argv[++i]
  }
  const result = await runManualQa({ slug, baseUrl })
  for (const line of result.lines) console.log(line)
  return result.ok ? 0 : 1
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().then((code) => {
    process.exitCode = code
  })
}
