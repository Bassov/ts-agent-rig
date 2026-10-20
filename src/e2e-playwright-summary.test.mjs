import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildBurnInArgs,
  countFailedTests,
  countFlakyRetriedPasses,
  formatE2eSectionMarkdown,
  main,
  optionalArg,
  parseArgs,
} from './e2e-playwright-summary.mjs'

describe('countFlakyRetriedPasses', () => {
  it('counts retried passes', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  results: [{ status: 'failed' }, { status: 'passed' }],
                },
                {
                  results: [{ status: 'passed' }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(countFlakyRetriedPasses(report)).toBe(1)
  })

  it('returns 0 when nothing flaked', () => {
    expect(
      countFlakyRetriedPasses({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }],
      }),
    ).toBe(0)
    expect(countFlakyRetriedPasses(null)).toBe(0)
    expect(countFlakyRetriedPasses({})).toBe(0)
  })

  it('tolerates sparse suite/spec/test shapes', () => {
    expect(
      countFlakyRetriedPasses({
        suites: [
          {
            suites: [{ specs: null }],
            specs: [{ tests: null }, { tests: [{ results: null }] }],
          },
        ],
      }),
    ).toBe(0)
  })

  it('counts timedOut then passed as flaky', () => {
    expect(
      countFlakyRetriedPasses({
        suites: [
          {
            suites: [
              {
                specs: [
                  {
                    tests: [
                      {
                        results: [{ status: 'timedOut' }, { status: 'passed' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(1)
  })
})

describe('countFailedTests', () => {
  it('counts final failed and timedOut', () => {
    expect(
      countFailedTests({
        suites: [
          {
            specs: [
              {
                tests: [
                  { results: [{ status: 'failed' }] },
                  { results: [{ status: 'passed' }, { status: 'timedOut' }] },
                  { results: [{ status: 'passed' }] },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(2)
  })

  it('returns 0 for empty report', () => {
    expect(countFailedTests({})).toBe(0)
    expect(countFailedTests(null)).toBe(0)
  })

  it('tolerates sparse suite/spec/test shapes', () => {
    expect(
      countFailedTests({
        suites: [
          {
            suites: [{}],
            specs: [{}, { tests: [{}, { results: [{ status: 'failed' }] }] }],
          },
        ],
      }),
    ).toBe(1)
  })
})

describe('optionalArg / parseArgs', () => {
  it('optionalArg drops missing, empty, and bare flags', () => {
    expect(optionalArg(undefined)).toBeNull()
    expect(optionalArg(true)).toBeNull()
    expect(optionalArg('')).toBeNull()
    expect(optionalArg(10)).toBe('10')
    expect(optionalArg('ok')).toBe('ok')
  })

  it('parseArgs handles positionals and bare flags', () => {
    expect(
      parseArgs(['pos', '--report', 'a.json', '--burn-in', '--out']),
    ).toEqual({
      _: ['pos'],
      report: 'a.json',
      'burn-in': true,
      out: true,
    })
  })
})

describe('buildBurnInArgs', () => {
  it('builds playwright burn-in argv', () => {
    expect(
      buildBurnInArgs({
        targets: ['e2e/smoke.spec.ts', 'e2e/a.spec.ts'],
        count: 10,
      }),
    ).toEqual([
      'playwright',
      'test',
      '--project=chromium',
      'e2e/smoke.spec.ts',
      'e2e/a.spec.ts',
      '--repeat-each=10',
      '--retries=0',
      '--workers=1',
    ])
  })

  it('rejects non-positive count', () => {
    expect(() => buildBurnInArgs({ targets: [], count: 0 })).toThrow(
      /positive integer/,
    )
    expect(() => buildBurnInArgs({ targets: [], count: 1.5 })).toThrow(
      /positive integer/,
    )
  })

  it('drops empty targets', () => {
    expect(buildBurnInArgs({ targets: ['', '  '], count: 3 })).toEqual([
      'playwright',
      'test',
      '--project=chromium',
      '--repeat-each=3',
      '--retries=0',
      '--workers=1',
    ])
    expect(buildBurnInArgs({ targets: null, count: 2 })).toEqual([
      'playwright',
      'test',
      '--project=chromium',
      '--repeat-each=2',
      '--retries=0',
      '--workers=1',
    ])
  })
})

describe('integration workflow burn-in policy', () => {
  it('matches buildBurnInArgs flags and parallel no-op job shape', () => {
    const yml = readFileSync(
      resolve('.github/workflows/integration.yml'),
      'utf8',
    )
    expect(yml).toMatch(
      /--repeat-each=\$\{\{\s*steps\.burn-in-count\.outputs\.count\s*\}\}/,
    )
    expect(yml).toMatch(/--retries=0/)
    expect(yml).toMatch(/--workers=1/)
    expect(yml).toMatch(/--project=chromium/)
    expect(yml).toMatch(/^\s*e2e-burn-in:\s*$/m)
    expect(yml).toMatch(/^\s*e2e:\s*$/m)
    expect(yml).toMatch(/^\s*e2e-flaky-resolve:\s*$/m)
    expect(yml).toMatch(/^\s*e2e-flaky:\s*$/m)
    expect(yml).toMatch(
      /e2e-flaky:[\s\S]*?if:\s*needs\.e2e-flaky-resolve\.outputs\.has_targets == 'true'/,
    )
    expect(yml).toMatch(/^\s*integration:\s*$/m)
    expect(yml).toMatch(
      /integration:[\s\S]*?needs:\s*\[e2e,\s*e2e-burn-in,\s*e2e-flaky-resolve,\s*e2e-flaky\]/,
    )
    expect(yml).toMatch(
      /ci-comment:[\s\S]*?needs:\s*\[e2e,\s*e2e-burn-in,\s*e2e-flaky,\s*integration\]/,
    )
    expect(yml).toMatch(/No burn-in targets/)
    // Required gate fails when burn-in fails on PRs.
    expect(yml).toMatch(
      /e2e-burn-in job result=\$BURN_IN_RESULT \(need success on pull_request\)/,
    )
    expect(yml).toMatch(
      /e2e-flaky-resolve job result=\$FLAKY_RESOLVE_RESULT \(need success\)/,
    )
    expect(yml).toMatch(
      /e2e-flaky job result=\$FLAKY_RESULT \(need success or skipped\)/,
    )
    // No-target path must not require pnpm install before target resolve.
    const burnJob = yml.split(/^  e2e:/m)[0]
    expect(burnJob).not.toMatch(/^\s*needs:/m)
    const resolveIdx = burnJob.indexOf('Resolve burn-in targets')
    const installIdx = burnJob.indexOf('Install dependencies')
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(installIdx).toBeGreaterThan(resolveIdx)
    expect(burnJob).toMatch(
      /if:\s*steps\.burn-in-targets\.outputs\.has_targets == 'true'[\s\S]*Install dependencies/,
    )
    // e2e and burn-in stay parallel (neither needs the other).
    const e2eJob = yml.split(/^  e2e:/m)[1]?.split(/^  e2e-flaky:/m)[0] ?? ''
    expect(e2eJob).not.toMatch(/^\s*needs:/m)
    const args = buildBurnInArgs({
      targets: ['e2e/burn-in-smoke.spec.ts'],
      count: 50,
    })
    expect(args).toContain('--project=chromium')
    expect(args).toContain('--repeat-each=50')
    expect(args).toContain('--retries=0')
    expect(args).toContain('--workers=1')
  })
})

describe('formatE2eSectionMarkdown', () => {
  it('includes flaky and burn-in rows', () => {
    const body = formatE2eSectionMarkdown({
      burnInCount: 50,
      flakyCount: 2,
      flakyListCount: 1,
    })
    expect(body).toContain('| Flaky (retried pass) | 2 |')
    expect(body).toContain('| @flaky list | 1 |')
    expect(body).toContain('| Burn-in | 50 |')
  })

  it('omits burn-in when null', () => {
    const body = formatE2eSectionMarkdown({ burnInCount: null, flakyCount: 0 })
    expect(body).toContain('| Flaky (retried pass) | 0 |')
    expect(body).toContain('| @flaky list | 0 |')
    expect(body).not.toContain('| Burn-in |')
  })

  it('includes burn-in result with failed count', () => {
    const body = formatE2eSectionMarkdown({
      burnInCount: 10,
      flakyCount: 0,
      burnInOutcome: 'failure',
      burnInFailedCount: 3,
    })
    expect(body).toContain('| Burn-in result | failed (3 failed) |')
  })

  it('includes failed without count when count omitted', () => {
    const body = formatE2eSectionMarkdown({
      burnInCount: 10,
      flakyCount: 0,
      burnInOutcome: 'failure',
    })
    expect(body).toContain('| Burn-in result | failed |')
    expect(body).not.toContain('failed (')
  })

  it('includes passed burn-in result', () => {
    const body = formatE2eSectionMarkdown({
      burnInCount: 10,
      flakyCount: 1,
      burnInOutcome: 'success',
    })
    expect(body).toContain('| Burn-in result | passed |')
  })

  it('omits burn-in result when skipped', () => {
    const body = formatE2eSectionMarkdown({
      burnInCount: null,
      flakyCount: 0,
      burnInOutcome: 'skipped',
    })
    expect(body).not.toContain('| Burn-in result |')
  })
})

describe('main CLI', () => {
  it('writes markdown with burn-in outcome from report', () => {
    let written = ''
    const files = {
      'main.json': JSON.stringify({
        suites: [
          {
            specs: [
              {
                tests: [
                  { results: [{ status: 'failed' }, { status: 'passed' }] },
                ],
              },
            ],
          },
        ],
      }),
      'burn.json': JSON.stringify({
        suites: [
          {
            specs: [
              {
                tests: [{ results: [{ status: 'failed' }] }],
              },
            ],
          },
        ],
      }),
    }
    main(
      [
        '--report',
        'main.json',
        '--burn-in',
        '10',
        '--burn-in-outcome',
        'failure',
        '--burn-in-report',
        'burn.json',
        '--out',
        'out.md',
      ],
      {
        exists: (path) => path in files || path === 'out.md',
        loadJson: (path) => JSON.parse(files[path]),
        writeFile: (_path, body) => {
          written = body
        },
      },
    )
    expect(written).toContain('| Flaky (retried pass) | 1 |')
    expect(written).toContain('| Burn-in | 10 |')
    expect(written).toContain('| Burn-in result | failed (1 failed) |')
  })

  it('writes to stdout when --out omitted or bare', () => {
    let out = ''
    const files = {
      'main.json': JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }],
      }),
    }
    main(['--report', 'main.json', '--burn-in', '--out'], {
      exists: (path) => path in files,
      loadJson: (path) => JSON.parse(files[path]),
      write: (text) => {
        out += text
      },
    })
    expect(out).toContain('| Flaky (retried pass) | 0 |')
    expect(out).not.toContain('| Burn-in |')
  })

  it('ignores bare --burn-in-report flag', () => {
    let written = ''
    const files = {
      'main.json': JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }],
      }),
    }
    main(
      [
        '--report',
        'main.json',
        '--burn-in',
        '5',
        '--burn-in-outcome',
        'failure',
        '--burn-in-report',
        '--out',
        'out.md',
      ],
      {
        exists: (path) => path === 'main.json' || path === 'out.md',
        loadJson: (path) => JSON.parse(files[path]),
        writeFile: (_path, body) => {
          written = body
        },
      },
    )
    expect(written).toContain('| Burn-in result | failed |')
    expect(written).not.toContain('failed (')
  })

  it('ignores missing burn-in-report file', () => {
    let written = ''
    const files = {
      'main.json': JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }],
      }),
    }
    main(
      [
        '--report',
        'main.json',
        '--burn-in',
        '5',
        '--burn-in-outcome',
        'failure',
        '--burn-in-report',
        'missing.json',
        '--out',
        'out.md',
      ],
      {
        exists: (path) => path === 'main.json' || path === 'out.md',
        loadJson: (path) => JSON.parse(files[path]),
        writeFile: (_path, body) => {
          written = body
        },
      },
    )
    expect(written).toContain('| Burn-in result | failed |')
  })

  it('throws when report is missing', () => {
    expect(() =>
      main(['--report', 'missing.json'], { exists: () => false }),
    ).toThrow(/Usage:/)
    expect(() => main([], { exists: () => false })).toThrow(/Usage:/)
  })

  it('uses real fs defaults for report and out file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-summary-'))
    const report = join(dir, 'report.json')
    const out = join(dir, 'out.md')
    const burn = join(dir, 'burn.json')
    writeFileSync(
      report,
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                tests: [
                  { results: [{ status: 'failed' }, { status: 'passed' }] },
                ],
              },
            ],
          },
        ],
      }),
    )
    writeFileSync(
      burn,
      JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'failed' }] }] }] }],
      }),
    )
    main([
      '--report',
      report,
      '--burn-in',
      '10',
      '--burn-in-outcome',
      'failure',
      '--burn-in-report',
      burn,
      '--out',
      out,
    ])
    const body = readFileSync(out, 'utf8')
    expect(body).toContain('| Flaky (retried pass) | 1 |')
    expect(body).toContain('| Burn-in result | failed (1 failed) |')
  })

  it('spawned CLI entry prints markdown for a temp report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-summary-cli-'))
    const report = join(dir, 'report.json')
    writeFileSync(
      report,
      JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }],
      }),
    )
    const out = execFileSync(
      process.execPath,
      [
        resolve('packages/ts-agent-rig/src/e2e-playwright-summary-cli.mjs'),
        '--report',
        report,
        '--burn-in',
        '10',
        '--burn-in-outcome',
        'success',
      ],
      { encoding: 'utf8' },
    )
    expect(out).toContain('| Burn-in | 10 |')
    expect(out).toContain('| Burn-in result | passed |')
  })

  it('spawned CLI surfaces usage errors', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve('packages/ts-agent-rig/src/e2e-playwright-summary-cli.mjs')],
        { encoding: 'utf8' },
      ),
    ).toThrow(/Usage:/)
  })

  it('main without argv array throws usage', () => {
    expect(() => main()).toThrow(/Usage:/)
    expect(() => main(null)).toThrow(/Usage:/)
  })

  it('default stdout writer emits markdown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-summary-stdout-'))
    const report = join(dir, 'report.json')
    writeFileSync(
      report,
      JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }],
      }),
    )
    const chunks = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(String(chunk))
      return original(chunk, ...rest)
    }
    try {
      main([
        '--report',
        report,
        '--burn-in',
        '3',
        '--burn-in-outcome',
        'success',
      ])
    } finally {
      process.stdout.write = original
    }
    expect(chunks.join('')).toContain('| Burn-in | 3 |')
    expect(chunks.join('')).toContain('| Burn-in result | passed |')
  })
})
