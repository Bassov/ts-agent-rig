import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { main, resolveChangedE2eTargets } from './e2e-changed-quiet.mjs'

const here = dirname(fileURLToPath(import.meta.url))

describe('resolveChangedE2eTargets', () => {
  it('reuses burn-in selection for changed specs', () => {
    const targets = resolveChangedE2eTargets('origin/main', {
      gitLines: () => ['e2e/smoke.spec.ts', 'README.md'],
      exists: (path) => path === 'e2e/smoke.spec.ts',
      isFile: (path) => path === 'e2e/smoke.spec.ts',
      listSources: () => ['e2e/smoke.spec.ts'],
      readFile: () => '',
    })
    expect(targets).toEqual(['e2e/smoke.spec.ts'])
  })

  it('returns empty when diff has no e2e targets', () => {
    const targets = resolveChangedE2eTargets('origin/main', {
      gitLines: () => ['README.md'],
      listSources: () => [],
    })
    expect(targets).toEqual([])
  })

  it('default isFile uses exists+statSync on real paths', () => {
    const targets = resolveChangedE2eTargets('origin/main', {
      gitLines: () => ['e2e/burn-in-smoke.spec.ts', 'e2e'],
      exists: (path) => path === 'e2e/burn-in-smoke.spec.ts' || path === 'e2e',
      // omit isFile — exercise the default exists+statSync implementation
      listSources: () => ['e2e/burn-in-smoke.spec.ts'],
      readFile: () => '',
    })
    expect(targets).toEqual(['e2e/burn-in-smoke.spec.ts'])
  })

  it('default isFile returns false when exists throws', () => {
    const targets = resolveChangedE2eTargets('origin/main', {
      gitLines: () => ['e2e/boom.spec.ts'],
      exists: () => {
        throw new Error('stat race')
      },
      listSources: () => ['e2e/boom.spec.ts'],
      readFile: () => '',
    })
    expect(targets).toEqual([])
  })
})

describe('main', () => {
  it('prints no targets and skips Playwright when empty', () => {
    let out = ''
    let spawned = false
    const code = main(
      {},
      {
        gitLines: () => ['README.md'],
        listSources: () => [],
        spawnSync: () => {
          spawned = true
          return { status: 0, stdout: '', stderr: '' }
        },
        write: (text) => {
          out += text
        },
      },
    )
    expect(code).toBe(0)
    expect(spawned).toBe(false)
    expect(out).toBe('changed-e2e: no targets\n')
  })

  it('runs quiet Playwright on targets and prints a one-line summary', () => {
    let out = ''
    let err = ''
    let argv = null
    const code = main(
      { STRYKER_DIFF_BASE: 'origin/main' },
      {
        gitLines: () => ['e2e/smoke.spec.ts'],
        exists: (path) => path === 'e2e/smoke.spec.ts',
        isFile: (path) => path === 'e2e/smoke.spec.ts',
        listSources: () => ['e2e/smoke.spec.ts'],
        readFile: () => '',
        spawnSync: (_file, args) => {
          argv = args
          return {
            status: 0,
            stdout: '····\n',
            stderr: '',
          }
        },
        write: (text) => {
          out += text
        },
        error: (text) => {
          err += String(text)
        },
      },
    )
    expect(code).toBe(0)
    expect(argv).toEqual([
      join(here, 'with-playwright-env.mjs'),
      'playwright',
      'test',
      '--project=chromium',
      '--workers=1',
      'e2e/smoke.spec.ts',
      '--reporter=dot',
    ])
    expect(out).toContain('····')
    expect(out).toContain('changed-e2e: 1 target(s) passed')
    expect(err).toBe('')
  })

  it('surfaces Playwright stderr and failed summary', () => {
    let out = ''
    let err = ''
    const code = main(
      {},
      {
        gitLines: () => ['e2e/smoke.spec.ts'],
        exists: (path) => path === 'e2e/smoke.spec.ts',
        isFile: (path) => path === 'e2e/smoke.spec.ts',
        listSources: () => ['e2e/smoke.spec.ts'],
        readFile: () => '',
        spawnSync: () => ({
          status: 1,
          stdout: '',
          stderr: '1 failed\n',
        }),
        write: (text) => {
          out += text
        },
        error: (text) => {
          err += String(text)
        },
      },
    )
    expect(code).toBe(1)
    expect(err).toContain('1 failed')
    expect(out).toContain('changed-e2e: 1 target(s) failed (exit 1)')
  })

  it('returns 1 when target resolution throws', () => {
    let err = ''
    const code = main(
      {},
      {
        gitLines: () => {
          throw new Error('git down')
        },
        error: (text) => {
          err += String(text)
        },
      },
    )
    expect(code).toBe(1)
    expect(err).toContain('git down')
  })

  it('pipes Playwright stdio, forwards env, and treats null status as failure', () => {
    let opts = null
    let writes = []
    let errors = []
    const code = main(
      { MARKER: 'keep-me', STRYKER_DIFF_BASE: 'origin/main' },
      {
        gitLines: () => ['e2e/smoke.spec.ts'],
        exists: (path) => path === 'e2e/smoke.spec.ts',
        isFile: (path) => path === 'e2e/smoke.spec.ts',
        listSources: () => ['e2e/smoke.spec.ts'],
        readFile: () => '',
        spawnSync: (_file, _args, options) => {
          opts = options
          return { status: null, stdout: 'out\n', stderr: 'err\n' }
        },
        write: (text) => {
          writes.push(text)
        },
        error: (text) => {
          errors.push(String(text))
        },
      },
    )
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(opts.env.MARKER).toBe('keep-me')
    expect(code).toBe(1)
    expect(writes).toEqual([
      'out\n',
      'changed-e2e: 1 target(s) failed (exit 1)\n',
    ])
    expect(errors).toEqual(['err\n'])
  })

  it('does not forward empty Playwright streams', () => {
    const writes = []
    const errors = []
    const code = main(
      {},
      {
        gitLines: () => ['e2e/smoke.spec.ts'],
        exists: (path) => path === 'e2e/smoke.spec.ts',
        isFile: (path) => path === 'e2e/smoke.spec.ts',
        listSources: () => ['e2e/smoke.spec.ts'],
        readFile: () => '',
        spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
        write: (text) => {
          writes.push(text)
        },
        error: (text) => {
          errors.push(String(text))
        },
      },
    )
    expect(code).toBe(0)
    expect(writes).toEqual(['changed-e2e: 1 target(s) passed\n'])
    expect(errors).toEqual([])
  })

  it('treats nullish Playwright streams as empty', () => {
    const writes = []
    const errors = []
    const code = main(
      {},
      {
        gitLines: () => ['e2e/smoke.spec.ts'],
        exists: (path) => path === 'e2e/smoke.spec.ts',
        isFile: (path) => path === 'e2e/smoke.spec.ts',
        listSources: () => ['e2e/smoke.spec.ts'],
        readFile: () => '',
        spawnSync: () => ({
          status: 2,
          stdout: null,
          stderr: undefined,
        }),
        write: (text) => {
          writes.push(text)
        },
        error: (text) => {
          errors.push(String(text))
        },
      },
    )
    expect(code).toBe(2)
    expect(writes).toEqual(['changed-e2e: 1 target(s) failed (exit 2)\n'])
    expect(errors).toEqual([])
  })

  it('uses default STRYKER_DIFF_BASE when unset', () => {
    const seen = []
    const code = main(
      {},
      {
        gitLines: (args) => {
          seen.push(args.join(' '))
          return []
        },
        listSources: () => [],
        flakyPaths: [],
        write: () => {},
      },
    )
    expect(code).toBe(0)
    expect(seen.some((line) => line.includes('origin/main'))).toBe(true)
  })

  it('uses STRYKER_DIFF_BASE when set (phase SHA)', () => {
    const seen = []
    const code = main(
      { STRYKER_DIFF_BASE: 'phase-sha' },
      {
        gitLines: (args) => {
          seen.push(args.join(' '))
          return []
        },
        listSources: () => [],
        flakyPaths: [],
        write: () => {},
      },
    )
    expect(code).toBe(0)
    expect(seen.some((line) => line.includes('phase-sha'))).toBe(true)
    expect(seen.some((line) => line.includes('origin/main'))).toBe(false)
  })

  it('default write/error hit process stdio when io omits them', () => {
    const writes = []
    const errors = []
    const origWrite = process.stdout.write.bind(process.stdout)
    const origError = console.error
    process.stdout.write = (chunk) => {
      writes.push(String(chunk))
      return true
    }
    console.error = (...args) => {
      errors.push(args.map(String).join(' '))
    }
    try {
      const noTargets = main({}, { gitLines: () => [], listSources: () => [] })
      expect(noTargets).toBe(0)
      expect(writes.join('')).toContain('changed-e2e: no targets')

      writes.length = 0
      const failed = main(
        {},
        {
          gitLines: () => ['e2e/smoke.spec.ts'],
          exists: (path) => path === 'e2e/smoke.spec.ts',
          isFile: (path) => path === 'e2e/smoke.spec.ts',
          listSources: () => ['e2e/smoke.spec.ts'],
          readFile: () => '',
          spawnSync: () => ({
            status: 1,
            stdout: null,
            stderr: 'boom\n',
          }),
        },
      )
      expect(failed).toBe(1)
      expect(writes.join('')).toContain('failed (exit 1)')
      expect(errors.join('')).toContain('boom')
    } finally {
      process.stdout.write = origWrite
      console.error = origError
    }
  })
})
