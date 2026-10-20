import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bootCli,
  buildAfterUnitInventory,
  buildInventory,
  resolveCheckTables,
  DEFAULT_CORE_CHECKS,
  extractProblemLines,
  formatCheckResult,
  isNoiseLine,
  main,
  NOISE_STARTS,
  PROBLEM_CAP,
  parseRunArgs,
  runChecks,
  runOneCheck,
  stripAnsi,
} from './check.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(here, 'fixtures', 'check-failures')

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-cli-'))
  tmpDirs.push(d)
  return d
}

function assertCompactFailure(checkName, raw, { fileSnippet }) {
  const lines = extractProblemLines(raw, checkName)
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.length).toBeLessThanOrEqual(20)
  expect(lines.every((l) => l.startsWith(`${checkName}: `))).toBe(true)
  expect(lines.some((l) => l.includes(fileSnippet))).toBe(true)
  expect(lines.some((l) => /^[A-Z]*\s*RUN\b/i.test(l))).toBe(false)
  expect(
    lines.filter((l) => /(?:❯|\bat\s+)/.test(l)).length,
  ).toBeLessThanOrEqual(1)
  const joined = lines.join('\n')
  expect(joined).not.toMatch(/JUNIT report written/i)
  expect(joined).not.toMatch(/Test Files\s+\d+\s+failed/i)
}

/** @param {Record<string, { code?: number, stdout?: string, stderr?: string }>} byName */
function fakeSpawnByCheckName(byName) {
  return (file, args) => {
    const ee = new EventEmitter()
    ee.stdout = new EventEmitter()
    ee.stderr = new EventEmitter()
    const key = args.includes('typecheck')
      ? 'typecheck'
      : args.includes('lint')
        ? 'lint'
        : args.includes('deps')
          ? 'deps'
          : args.includes('knip')
            ? 'knip'
            : args.includes('mutation-scope')
              ? 'mutation-scope'
              : args.includes('gate-values')
                ? 'gate-values'
                : args.includes('openspec-budget')
                  ? 'openspec-budget'
                  : args.includes('codecov-yml')
                    ? 'codecov-yml'
                    : args.includes('git-test-isolation')
                      ? 'git-test-isolation'
                      : args.includes('roadmap')
                        ? 'roadmap'
                        : args.includes('test:quiet') || args.includes('vitest')
                          ? 'unit'
                          : args.some((a) =>
                                String(a).includes('check-patch-coverage'),
                              )
                            ? 'patch-coverage'
                            : args.some((a) =>
                                  String(a).includes('check-diff-size'),
                                )
                              ? 'diff-size'
                              : args.some((a) =>
                                    String(a).includes('check-pr-body'),
                                  )
                                ? 'pr-body'
                                : 'unknown'
    const res = byName[key] ?? { code: 0, stdout: '', stderr: '' }
    queueMicrotask(() => {
      if (res.stdout) ee.stdout.emit('data', res.stdout)
      if (res.stderr) ee.stderr.emit('data', res.stderr)
      ee.emit('close', res.code ?? 0)
    })
    return ee
  }
}

describe('isNoiseLine / bootCli', () => {
  it('flags banners, code context, and diff chrome as noise', () => {
    for (const prefix of NOISE_STARTS) {
      expect(isNoiseLine(`${prefix} trailing`), prefix).toBe(true)
    }
    expect(isNoiseLine('')).toBe(true)
    expect(isNoiseLine(null)).toBe(true)
    expect(isNoiseLine('---')).toBe(true)
    expect(isNoiseLine('⎯⎯⎯')).toBe(true)
    expect(isNoiseLine('-')).toBe(true)
    expect(isNoiseLine('+')).toBe(true)
    expect(isNoiseLine('      4| expect(1)')).toBe(true)
    expect(isNoiseLine('0| code')).toBe(true)
    expect(isNoiseLine('9| code')).toBe(true)
    expect(isNoiseLine('a| not-noise')).toBe(false)
    expect(isNoiseLine('foo---')).toBe(false)
    expect(isNoiseLine('- Expected')).toBe(true)
    expect(isNoiseLine('+ Received')).toBe(true)
    expect(isNoiseLine('src/a.ts:1:1 error x')).toBe(false)
    expect(isNoiseLine('single-line: docs/roadmap.md:5: x')).toBe(false)
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red')
    expect(stripAnsi(null)).toBe('')
  })

  it('bootCli starts main only for this module path', async () => {
    let called = false
    let exit = null
    expect(
      bootCli('/other/path.mjs', import.meta.url, async () => {
        called = true
        return 0
      }),
    ).toBe(false)
    expect(called).toBe(false)
    expect(bootCli('', import.meta.url)).toBe(false)
    expect(bootCli(null, import.meta.url)).toBe(false)

    const self = path.resolve(here, 'check.mjs')
    expect(
      bootCli(
        self,
        `file://${self}`,
        async () => {
          called = true
          return 7
        },
        (code) => {
          exit = code
        },
      ),
    ).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(called).toBe(true)
    expect(exit).toBe(7)

    const prevExit = process.exitCode
    let defaultCalled = false
    expect(
      bootCli(self, `file://${self}`, async () => {
        defaultCalled = true
        return 9
      }),
    ).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(defaultCalled).toBe(true)
    expect(process.exitCode).toBe(9)
    process.exitCode = prevExit

    expect(bootCli(undefined, import.meta.url)).toBe(false)
    expect(PROBLEM_CAP).toBe(20)
  })
})

describe('buildInventory', () => {
  it('always schedules the core deterministic inventory', () => {
    const inv = buildInventory('/tmp/none', {
      existsSync: () => false,
      loadGatesFn: () => {
        throw new Error('no gates')
      },
    })
    expect(inv.map((c) => c.name)).toEqual(
      DEFAULT_CORE_CHECKS.map((c) => c.name),
    )
  })

  it('includes optional policy scripts only when present', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/check-diff-size.mjs'), '')
    const inv = buildInventory(root, {
      loadGatesFn: () => ({
        checks: {
          core: [{ name: 'lint', argv: ['pnpm', 'lint'] }],
          afterUnit: [],
          optional: [
            { name: 'diff-size', script: 'scripts/check-diff-size.mjs' },
            { name: 'pr-body', script: 'scripts/check-pr-body.mjs' },
          ],
        },
      }),
    })
    expect(inv.map((c) => c.name)).toContain('diff-size')
    expect(inv.map((c) => c.name)).not.toContain('pr-body')
    const diff = inv.find((c) => c.name === 'diff-size')
    expect(diff.argv).toEqual([
      process.execPath,
      path.join(root, 'scripts/check-diff-size.mjs'),
    ])
  })

  it('resolveCheckTables prefers gates.json checks.core', () => {
    const tables = resolveCheckTables('/repo', {
      loadGatesFn: () => ({
        checks: {
          core: [{ name: 'lint', argv: ['pnpm', 'lint'] }],
          afterUnit: [],
          optional: [],
        },
      }),
    })
    expect(tables.core).toEqual([{ name: 'lint', argv: ['pnpm', 'lint'] }])
  })

  it('normalizeCheckRow paths via resolveCheckTables drop invalid rows', () => {
    const tables = resolveCheckTables('/repo', {
      loadGatesFn: () => ({
        checks: {
          core: [
            { name: 'ok', argv: ['pnpm', 'lint'] },
            { name: 'empty-argv', argv: [] },
            { name: 'non-string-argv', argv: [1, 2] },
            null,
            { name: '' },
            { name: 'neither' },
            { name: 'script-only', script: 'scripts/x.mjs' },
          ],
          afterUnit: [{ name: 'via-argv', argv: ['node', 'scripts/y.mjs'] }],
          optional: [{ name: 'skip-no-script', argv: ['echo'] }],
        },
      }),
    })
    expect(tables.core).toEqual([
      { name: 'ok', argv: ['pnpm', 'lint'] },
      { name: 'script-only', script: 'scripts/x.mjs' },
    ])
    expect(tables.afterUnit).toEqual([
      { name: 'via-argv', argv: ['node', 'scripts/y.mjs'] },
    ])
  })

  it('buildInventory resolves core script entries and skips missing optional', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/core-script.mjs'), '')
    const inv = buildInventory(root, {
      loadGatesFn: () => ({
        checks: {
          core: [{ name: 'core-script', script: 'scripts/core-script.mjs' }],
          afterUnit: [],
          optional: [
            { name: 'missing', script: 'scripts/nope.mjs' },
            { name: 'no-script-field', argv: ['true'] },
          ],
        },
      }),
    })
    expect(inv).toEqual([
      {
        name: 'core-script',
        argv: [process.execPath, path.join(root, 'scripts/core-script.mjs')],
      },
      { name: 'no-script-field', argv: ['true'] },
    ])
  })

  it('buildAfterUnitInventory skips missing scripts and accepts argv rows', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/present.mjs'), '')
    const list = buildAfterUnitInventory(root, {
      loadGatesFn: () => ({
        checks: {
          core: [{ name: 'lint', argv: ['pnpm', 'lint'] }],
          afterUnit: [
            { name: 'missing', script: 'scripts/absent.mjs' },
            { name: 'present', script: 'scripts/present.mjs' },
            { name: 'argv-row', argv: ['node', 'scripts/present.mjs'] },
          ],
          optional: [],
        },
      }),
    })
    expect(list.map((c) => c.name)).toEqual(['present', 'argv-row'])
    expect(list[0].argv[1]).toBe(path.join(root, 'scripts/present.mjs'))
    expect(list[1].argv).toEqual(['node', 'scripts/present.mjs'])
  })
})

describe('extractProblemLines / formatCheckResult', () => {
  it('caps failures and points at the log path', () => {
    const problems = Array.from({ length: 25 }, (_, i) => `lint: f.ts:${i} x`)
    const text = formatCheckResult(
      {
        name: 'lint',
        ok: false,
        ms: 1200,
        problems,
        logPath: '.cache/checks/lint.log',
        code: 1,
      },
      { problemCap: 20 },
    )
    const lines = text.split('\n')
    expect(lines.length).toBe(21)
    expect(lines[20]).toMatch(
      /\u2026 \+5 more, full log: \.cache\/checks\/lint\.log/,
    )
  })

  it('formats OK as one line without a dummy count', () => {
    expect(
      formatCheckResult({
        name: 'unit',
        ok: true,
        ms: 500,
        problems: [],
        logPath: '.cache/checks/unit.log',
        code: 0,
      }),
    ).toBe('OK unit (0.5s)')
  })

  it('compacts real eslint / vitest / roadmap fixtures to ≤20 problem lines', () => {
    assertCompactFailure(
      'lint',
      fs.readFileSync(path.join(FIX, 'eslint.txt'), 'utf8'),
      {
        fileSnippet: 'src/example.ts:1',
      },
    )
    assertCompactFailure(
      'unit',
      fs.readFileSync(path.join(FIX, 'vitest.txt'), 'utf8'),
      { fileSnippet: '_tmp_unit_fail.test.mjs:4' },
    )
    assertCompactFailure(
      'roadmap',
      fs.readFileSync(path.join(FIX, 'roadmap.txt'), 'utf8'),
      { fileSnippet: 'docs/roadmap.md:5' },
    )
  })

  it('runChecks surfaces all three fixture failures in one pass', async () => {
    const root = tmpRoot()
    let out = ''
    const summary = await runChecks({
      root,
      spawnImpl: fakeSpawnByCheckName({
        typecheck: { code: 0 },
        lint: {
          code: 1,
          stdout: fs.readFileSync(path.join(FIX, 'eslint.txt'), 'utf8'),
        },
        deps: { code: 0 },
        knip: { code: 0 },
        'mutation-scope': { code: 0 },
        'gate-values': { code: 0 },
        roadmap: {
          code: 1,
          stdout: fs.readFileSync(path.join(FIX, 'roadmap.txt'), 'utf8'),
        },
        unit: {
          code: 1,
          stdout: fs.readFileSync(path.join(FIX, 'vitest.txt'), 'utf8'),
        },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(summary.ok).toBe(false)
    expect(summary.failed.map((r) => r.name).sort()).toEqual([
      'lint',
      'roadmap',
      'unit',
    ])
    for (const name of ['lint', 'unit', 'roadmap']) {
      const result = summary.failed.find((r) => r.name === name)
      expect(result.problems.length).toBeLessThanOrEqual(20)
      expect(result.problems.length).toBeGreaterThan(0)
    }
    expect(out).not.toMatch(/\bPASS\b/)
  })

  it('prefers error-like lines from tool output', () => {
    const lines = extractProblemLines(
      'banner\nsrc/a.ts:3:1 error Unexpected\nok stuff\n',
      'lint',
    )
    expect(lines).toEqual(['lint: src/a.ts:3:1 error Unexpected'])
    expect(lines.some((l) => l.includes('banner'))).toBe(false)
  })

  it('strips ANSI and falls back when no preferred lines', () => {
    const ansi = '\x1B[31mplain note\x1B[0m\n'
    expect(extractProblemLines(ansi, 'deps')).toEqual(['deps: plain note'])
  })

  it('keeps TS error and file:line forms', () => {
    expect(
      extractProblemLines('error TS2304: Cannot find name\n', 'typecheck')[0],
    ).toContain('error TS2304')
    expect(extractProblemLines('only info\n', 'knip')).toEqual([
      'knip: only info',
    ])
  })

  it('under-cap failures still include full log path', () => {
    const text = formatCheckResult({
      name: 'lint',
      ok: false,
      ms: 10,
      problems: ['lint: a.ts:1 x'],
      logPath: '.cache/checks/lint.log',
      code: 1,
    })
    expect(text).toContain('full log: .cache/checks/lint.log')
    expect(text).not.toContain('\u2026')
  })

  it('omits full-log trailer only when logPath is empty', () => {
    const text = formatCheckResult({
      name: 'lint',
      ok: false,
      ms: 10,
      problems: ['lint: a.ts:1 x'],
      logPath: '',
      code: 1,
    })
    expect(text).toBe('lint: a.ts:1 x')
  })

  it('reassembles eslint path-only + col rows and keeps one stack frame', () => {
    const lines = extractProblemLines(
      [
        'src/example.ts',
        '  1:1  error  Unexpected  no-foo',
        '❯ src/a.test.ts:4:5',
        '❯ src/a.test.ts:8:1',
        'at Object.<anonymous> (src/a.test.ts:4:5)',
        'at ignore (src/a.test.ts:9:1)',
      ].join('\n'),
      'lint',
    )
    expect(lines[0]).toContain('src/example.ts:1:1')
    expect(lines.filter((l) => /❯|at\s+/.test(l))).toHaveLength(1)
  })
})

describe('runChecks', () => {
  it('reports lint, unit, and roadmap failures in one pass', async () => {
    const root = tmpRoot()
    let out = ''
    const summary = await runChecks({
      root,
      now: (() => {
        let t = 0
        return () => {
          t += 100
          return t
        }
      })(),
      spawnImpl: fakeSpawnByCheckName({
        typecheck: { code: 0 },
        lint: {
          code: 1,
          stdout: 'src/a.ts:1:1 error lint-fail\n',
        },
        deps: { code: 0 },
        knip: { code: 0 },
        'mutation-scope': { code: 0 },
        'gate-values': { code: 0 },
        roadmap: { code: 1, stderr: 'roadmap: docs/roadmap.md:1 bad\n' },
        unit: { code: 1, stdout: 'FAIL src/b.test.ts:2 unit-fail\n' },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(summary.ok).toBe(false)
    const failedNames = summary.failed.map((r) => r.name).sort()
    expect(failedNames).toEqual(['lint', 'roadmap', 'unit'])
    expect(out).toMatch(/lint:.*lint-fail/)
    expect(out).toMatch(/unit:.*unit-fail/)
    expect(out).toMatch(/roadmap:.*bad/)
    expect(fs.existsSync(path.join(root, '.cache/checks/lint.log'))).toBe(true)
    for (const name of failedNames) {
      const block = out
        .split('\n')
        .filter((l) => l.startsWith(`${name}:`) || l.startsWith('…'))
      expect(block.length).toBeLessThanOrEqual(21)
    }
  })

  it('prints at most one OK line per check when green', async () => {
    const root = tmpRoot()
    let out = ''
    const summary = await runChecks({
      root,
      spawnImpl: fakeSpawnByCheckName({
        typecheck: { code: 0 },
        lint: { code: 0 },
        deps: { code: 0 },
        knip: { code: 0 },
        'mutation-scope': { code: 0 },
        'gate-values': { code: 0 },
        'openspec-budget': { code: 0 },
        'codecov-yml': { code: 0 },
        roadmap: { code: 0 },
        unit: { code: 0 },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(summary.ok).toBe(true)
    const okLines = out.split('\n').filter((l) => l.startsWith('OK '))
    expect(okLines.length).toBe(10)
    expect(out).not.toMatch(/PASS|✓|passed/i)
    for (const r of summary.results) {
      expect(r.problems).toEqual([])
    }
  })

  it('does not schedule Playwright/e2e argv', async () => {
    const root = tmpRoot()
    /** @type {string[][]} */
    const calls = []
    await runChecks({
      root,
      spawnImpl: (file, args) => {
        calls.push([file, ...args])
        return fakeSpawnByCheckName({})(file, args)
      },
      write: () => {},
    })
    expect(
      calls.some((c) => c.some((a) => String(a).includes('playwright'))),
    ).toBe(false)
    expect(
      calls.some((c) => c.some((a) => String(a).includes('test:e2e'))),
    ).toBe(false)
  })
})

describe('main', () => {
  it('exits 1 when any check fails', async () => {
    const root = tmpRoot()
    const code = await main(['--verbose'], {
      root,
      spawnImpl: fakeSpawnByCheckName({
        lint: { code: 1, stdout: 'x.ts:1 error\n' },
      }),
      write: () => {},
    })
    expect(code).toBe(1)
  })

  it('honors --verbose and -v with full tool output', async () => {
    const root = tmpRoot()
    let out = ''
    /** @type {string[]} */
    const writes = []
    await main(['--verbose'], {
      root,
      inventory: [{ name: 'lint', argv: ['pnpm', 'lint'] }],
      spawnImpl: fakeSpawnByCheckName({
        lint: { code: 1, stdout: '  padded error line  \n', stderr: '' },
      }),
      write: (t) => {
        out += t
        writes.push(t)
      },
    })
    expect(out).toContain('--- lint ---')
    expect(out).toContain('  padded error line  ')
    expect(out).toMatch(/padded error line  \n/)
    expect(writes.includes('')).toBe(false)
    expect(out).not.toMatch(/padded error line  \n\n/)

    out = ''
    await main(['--verbose'], {
      root,
      inventory: [{ name: 'lint', argv: ['x'] }],
      spawnImpl: () => {
        const ee = new EventEmitter()
        ee.stdout = new EventEmitter()
        ee.stderr = new EventEmitter()
        queueMicrotask(() => {
          ee.stdout.emit('data', 'no-nl')
          ee.emit('close', 1)
        })
        return ee
      },
      write: (t) => {
        out += t
      },
    })
    expect(out).toContain('--- lint ---\nno-nl\n')
    expect(out).not.toContain('--- lint ---\nno-nl\n\n')

    out = ''
    await main(['-v'], {
      root,
      spawnImpl: fakeSpawnByCheckName({
        lint: { code: 1, stdout: 'verbose-via-v\n' },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(out).toContain('--- lint ---')
    expect(out).toContain('verbose-via-v')

    out = ''
    await main([], {
      root,
      spawnImpl: fakeSpawnByCheckName({
        lint: { code: 1, stdout: 'quiet-fail\n' },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(out).not.toContain('--- lint ---')
    expect(out).toContain('lint:')
  })

  it('honors --skip-unit and still runs every other check', async () => {
    const root = tmpRoot()
    const summary = await runChecks({
      root,
      skipUnit: true,
      spawnImpl: fakeSpawnByCheckName({}),
      write: () => {},
    })
    expect(summary.results.map((r) => r.name).sort()).toEqual([
      'codecov-yml',
      'deps',
      'gate-values',
      'knip',
      'lint',
      'mutation-scope',
      'openspec-budget',
      'roadmap',
      'typecheck',
    ])

    /** @type {string[][]} */
    const calls = []
    await main(['--skip-unit'], {
      root,
      spawnImpl: (file, args) => {
        calls.push([file, ...args])
        return fakeSpawnByCheckName({})(file, args)
      },
      write: () => {},
    })
    expect(calls.some((c) => c.includes('vitest'))).toBe(false)
    expect(calls.some((c) => c.includes('test:quiet'))).toBe(false)
    const joined = calls.map((c) => c.join(' '))
    for (const needle of [
      'typecheck',
      'lint',
      'deps',
      'knip',
      'mutation-scope',
      'gate-values',
      'openspec-budget',
      'codecov-yml',
      'roadmap',
    ]) {
      expect(joined.some((c) => c.includes(needle))).toBe(true)
    }
  })

  it('exits 0 when all green', async () => {
    const root = tmpRoot()
    const code = await main([], {
      root,
      spawnImpl: fakeSpawnByCheckName({}),
      write: () => {},
    })
    expect(code).toBe(0)
    const viaDefaultArgv = await main(undefined, {
      root,
      inventory: [{ name: 'only', argv: ['node', '-e', ''] }],
      spawnImpl: fakeSpawnByCheckName({}),
      write: () => {},
    })
    expect(viaDefaultArgv).toBe(0)

    const prevArgv = process.argv
    process.argv = ['--verbose', 'scripts/check.mjs']
    let slicedOut = ''
    try {
      await main(undefined, {
        root,
        inventory: [{ name: 'only', argv: ['x'] }],
        spawnImpl: fakeSpawnByCheckName({ only: { code: 0 } }),
        write: (t) => {
          slicedOut += t
        },
      })
    } finally {
      process.argv = prevArgv
    }
    // slice(2) drops --verbose; without slice, verbose headers appear.
    expect(slicedOut).not.toContain('--- only ---')
    expect(slicedOut).toMatch(/^OK only \(/m)
  })

  it('runChecks default now and write yield finite duration output', async () => {
    const root = tmpRoot()
    const summary = await runChecks({
      root,
      inventory: [{ name: 'only', argv: ['x'] }],
      spawnImpl: fakeSpawnByCheckName({ only: { code: 0 } }),
      write: () => {},
    })
    expect(Number.isFinite(summary.results[0].ms)).toBe(true)
    expect(summary.results[0].ms).toBeGreaterThanOrEqual(0)

    const chunks = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(String(chunk))
      return true
    }
    try {
      await runChecks({
        root,
        inventory: [{ name: 'only', argv: ['x'] }],
        spawnImpl: fakeSpawnByCheckName({ only: { code: 0 } }),
      })
    } finally {
      process.stdout.write = origWrite
    }
    expect(chunks.join('')).toMatch(/^OK only \(/m)
  })

  it('surfaces spawn errors as failed checks', async () => {
    const root = tmpRoot()
    const spawnImpl = () => {
      const ee = new EventEmitter()
      ee.stdout = new EventEmitter()
      ee.stderr = new EventEmitter()
      queueMicrotask(() => {
        ee.emit('error', new Error('spawn ENOENT'))
      })
      return ee
    }
    const summary = await runChecks({
      root,
      inventory: [{ name: 'lint', argv: ['missing-bin'] }],
      spawnImpl,
      write: () => {},
    })
    expect(summary.ok).toBe(false)
    expect(summary.failed[0].problems).toEqual(['lint: spawn ENOENT'])
  })

  it('treats null/undefined exit code as failure and clamps negative duration', async () => {
    const root = tmpRoot()
    const spawnNull = () => {
      const ee = new EventEmitter()
      ee.stdout = new EventEmitter()
      ee.stderr = new EventEmitter()
      queueMicrotask(() => ee.emit('close', null))
      return ee
    }
    let t = 1000
    const summary = await runChecks({
      root,
      inventory: [{ name: 'lint', argv: ['x'] }],
      spawnImpl: spawnNull,
      now: () => {
        t -= 500
        return t
      },
      write: () => {},
    })
    expect(summary.ok).toBe(false)
    expect(summary.results[0].code).toBe(1)
    expect(summary.results[0].ms).toBe(0)

    const spawnUndef = () => {
      const ee = new EventEmitter()
      ee.stdout = new EventEmitter()
      ee.stderr = new EventEmitter()
      queueMicrotask(() => ee.emit('close', undefined))
      return ee
    }
    const undefSummary = await runChecks({
      root,
      inventory: [{ name: 'lint', argv: ['x'] }],
      spawnImpl: spawnUndef,
      write: () => {},
    })
    expect(undefSummary.results[0].code).toBe(1)
  })

  it('main() uses real spawn for a tiny inventory without spawnImpl', async () => {
    const root = tmpRoot()
    let out = ''
    const code = await main([], {
      root,
      inventory: [
        {
          name: 'ok-child',
          argv: [process.execPath, '-e', 'process.stdout.write("ok\\n")'],
        },
        {
          name: 'bad-child',
          argv: [
            process.execPath,
            '-e',
            'console.error("scripts/real.ts:3:1 error boom"); process.exit(1)',
          ],
        },
      ],
      write: (t) => {
        out += t
      },
    })
    expect(code).toBe(1)
    expect(out).toMatch(/^OK ok-child \(/m)
    expect(out).toMatch(/bad-child:.*scripts\/real\.ts:3:1 error boom/)
  })
})

describe('runOneCheck env guard', () => {
  it('does not leak PHOTOBOOKS_CHECK_INNER into unit children', async () => {
    const root = tmpRoot()
    /** @type {NodeJS.ProcessEnv | null} */
    let seen = null
    await runChecks({
      root,
      inventory: [
        { name: 'unit', argv: ['pnpm', 'exec', 'vitest', 'run', '--silent'] },
      ],
      spawnImpl: (file, args, opts) => {
        seen = opts.env ?? null
        return fakeSpawnByCheckName({ unit: { code: 0 } })(file, args)
      },
      write: () => {},
    })
    expect(seen).not.toBe(null)
    expect(seen.PHOTOBOOKS_CHECK_INNER).toBeUndefined()
  })

  it('sets PHOTOBOOKS_CHECK_INNER only for roadmap children', async () => {
    const root = tmpRoot()
    /** @type {NodeJS.ProcessEnv | null} */
    let seen = null
    await runOneCheck({
      root,
      name: 'roadmap',
      argv: [process.execPath, path.join(here, 'roadmap.mjs'), 'check'],
      spawnImpl: (file, args, opts) => {
        seen = opts.env ?? null
        return fakeSpawnByCheckName({ roadmap: { code: 0 } })(file, args)
      },
      write: () => {},
    })
    expect(seen.PHOTOBOOKS_CHECK_INNER).toBe('1')
  })
})

describe('runOneCheck / --run', () => {
  it('parseRunArgs requires name and command after --', () => {
    expect(parseRunArgs(['--run', 'unit', '--', 'echo', 'hi'])).toEqual({
      name: 'unit',
      cmd: ['echo', 'hi'],
    })
    expect(() => parseRunArgs(['--run'])).toThrow(/usage/)
    expect(() => parseRunArgs(['--run', 'unit'])).toThrow(/usage/)
    expect(() => parseRunArgs(['--run', 'unit', '--'])).toThrow(/usage/)
    expect(() => parseRunArgs(['--run', '-x', '--', 'echo'])).toThrow(/usage/)
    expect(() => parseRunArgs(['--', '--run', 'unit', '--', 'echo'])).toThrow(
      /usage/,
    )
    expect(parseRunArgs(['--verbose'])).toBe(null)
  })

  it('runOneCheck rejects missing name or empty argv', async () => {
    await expect(runOneCheck({ name: '', argv: ['x'] })).rejects.toThrow(
      /name is required/,
    )
    await expect(runOneCheck({ name: 1, argv: ['x'] })).rejects.toThrow(
      /name is required/,
    )
    await expect(runOneCheck({ name: 'x', argv: [] })).rejects.toThrow(
      /non-empty command/,
    )
    await expect(runOneCheck({ name: 'x', argv: null })).rejects.toThrow(
      /non-empty command/,
    )
  })

  it('main --run usage errors exit 2 via stderr by default', async () => {
    let out = ''
    expect(
      await main(['--run'], {
        write: (t) => {
          out += t
        },
      }),
    ).toBe(2)
    expect(out).toMatch(/usage: node scripts\/check\.mjs --run/)

    const chunks = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (c) => {
      chunks.push(String(c))
      return true
    }
    try {
      expect(await main(['--run', 'unit'])).toBe(2)
    } finally {
      process.stderr.write = orig
    }
    expect(chunks.join('')).toMatch(/usage/)
  })

  it('CHECK_VERBOSE=1 enables verbose for --run', async () => {
    const root = tmpRoot()
    let out = ''
    const prev = process.env.CHECK_VERBOSE
    process.env.CHECK_VERBOSE = '1'
    try {
      await main(['--run', 'unit', '--', 'pnpm', 'exec', 'vitest'], {
        root,
        spawnImpl: fakeSpawnByCheckName({
          unit: { code: 0, stdout: 'via-env\n' },
        }),
        write: (t) => {
          out += t
        },
      })
    } finally {
      if (prev === undefined) delete process.env.CHECK_VERBOSE
      else process.env.CHECK_VERBOSE = prev
    }
    expect(out).toContain('--- unit ---')
    expect(out).toContain('via-env')
  })

  it('prints OK line on success and writes the log', async () => {
    const root = tmpRoot()
    let out = ''
    const result = await runOneCheck({
      root,
      name: 'unit',
      argv: ['pnpm', 'exec', 'vitest', 'run'],
      spawnImpl: fakeSpawnByCheckName({
        unit: { code: 0, stdout: 'silent\n' },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(result.ok).toBe(true)
    expect(out).toMatch(/^OK unit \(/m)
    expect(out).not.toContain('silent')
    expect(
      fs.readFileSync(path.join(root, '.cache/checks/unit.log'), 'utf8'),
    ).toContain('silent')
  })

  it('caps failure lines, preserves exit code, and logs full output', async () => {
    const root = tmpRoot()
    let out = ''
    const many = Array.from(
      { length: 25 },
      (_, i) => `src/f.ts:${i}:1 error e${i}`,
    ).join('\n')
    const code = await main(['--run', 'lint', '--', 'pnpm', 'lint'], {
      root,
      spawnImpl: fakeSpawnByCheckName({
        lint: { code: 3, stdout: `${many}\n` },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(code).toBe(3)
    const lines = out.trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(21)
    expect(lines.some((l) => l.startsWith('lint:'))).toBe(true)
    expect(out).toMatch(/full log: \.cache\/checks\/lint\.log/)
  })

  it('verbose passes tool output through', async () => {
    const root = tmpRoot()
    let out = ''
    await main(['--verbose', '--run', 'unit', '--', 'pnpm', 'exec', 'vitest'], {
      root,
      spawnImpl: fakeSpawnByCheckName({
        unit: { code: 0, stdout: 'tool-banner\n' },
      }),
      write: (t) => {
        out += t
      },
    })
    expect(out).toContain('--- unit ---')
    expect(out).toContain('tool-banner')
    expect(out).toMatch(/^OK unit \(/m)
  })

  it('main --run uses real spawn without spawnImpl', async () => {
    const root = tmpRoot()
    let out = ''
    const code = await main(
      [
        '--run',
        'demo',
        '--',
        process.execPath,
        '-e',
        'console.error("demo.ts:1:1 error nope"); process.exit(7)',
      ],
      {
        root,
        write: (t) => {
          out += t
        },
      },
    )
    expect(code).toBe(7)
    expect(out).toMatch(/demo:.*demo\.ts:1:1 error nope/)
    expect(fs.existsSync(path.join(root, '.cache/checks/demo.log'))).toBe(true)
  })

  it('main --run maps null exit to 1 and uses default write', async () => {
    const root = tmpRoot()
    const spawnNull = () => {
      const ee = new EventEmitter()
      ee.stdout = new EventEmitter()
      ee.stderr = new EventEmitter()
      queueMicrotask(() => ee.emit('close', null))
      return ee
    }
    expect(
      await main(['--run', 'lint', '--', 'pnpm', 'lint'], {
        root,
        spawnImpl: spawnNull,
        write: () => {},
      }),
    ).toBe(1)

    const chunks = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (c) => {
      chunks.push(String(c))
      return true
    }
    try {
      await runOneCheck({
        root,
        name: 'only',
        argv: ['pnpm', 'exec', 'vitest'],
        spawnImpl: fakeSpawnByCheckName({ unit: { code: 0 } }),
      })
    } finally {
      process.stdout.write = orig
    }
    expect(chunks.join('')).toMatch(/^OK only \(/m)
  })
})
