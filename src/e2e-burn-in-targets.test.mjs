import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildImportGraph,
  collectChangedPaths,
  extractRelativeImports,
  gitLines,
  isE2eSpec,
  isE2eSupportFile,
  listE2eSourceFiles,
  main,
  resolveE2eImport,
  selectBurnInTargets,
  transitiveImports,
} from './e2e-burn-in-targets.mjs'
import { gitTestEnv, initTmpRepo } from './git-test-helper.mjs'

function restoreStrykerDiffBase(prev) {
  if (prev === undefined) delete process.env.STRYKER_DIFF_BASE
  else process.env.STRYKER_DIFF_BASE = prev
}

const tmpDirs = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Resolved from this file, not process.cwd(): the CLI ships next to the test.
const BURN_IN_CLI = fileURLToPath(
  new URL('./e2e-burn-in-targets-cli.mjs', import.meta.url),
)

/** Minimal valid quality/gates.json, so the tmp repo needs no host copy. */
const CLI_GATES = {
  coverage: {
    statements: 80,
    branches: 80,
    functions: 80,
    lines: 80,
    patch: 85,
  },
  stryker: {
    thresholds: { high: 80, low: 60, break: 60 },
    diffThresholds: { high: 90, low: 85, break: 85 },
  },
  mutation: { disableBudget: 0, temporaryExcludes: [] },
  lighthouse: {
    numberOfRuns: 1,
    assertions: { 'performance-budget': 'error' },
    budgets: [{ path: '/*', resourceSizes: [], resourceCounts: [] }],
  },
  playwright: { retries: 0, flakyRetries: 2 },
  e2e: { burnInDefault: 10, flakySpecs: [] },
}

function runSpawnedCliBurnInTargets() {
  const tmpDir = initTmpRepo(tmpDirs, { prefix: 'burn-in-cli-' })
  mkdirSync(join(tmpDir, 'e2e'), { recursive: true })
  mkdirSync(join(tmpDir, 'quality'), { recursive: true })
  // CLI loads e2e.flakySpecs via loadGates({ root: process.cwd() }) = tmpDir.
  writeFileSync(join(tmpDir, 'quality/gates.json'), JSON.stringify(CLI_GATES))
  writeFileSync(
    join(tmpDir, 'e2e/burn-in-smoke.spec.ts'),
    "import { test } from '@playwright/test'\ntest('smoke', async () => {})\n",
  )
  const out = execFileSync(process.execPath, [BURN_IN_CLI], {
    encoding: 'utf8',
    cwd: tmpDir,
    env: {
      ...gitTestEnv({ STRYKER_DIFF_BASE: 'HEAD' }),
    },
  })
  expect(out.trim()).toBe('e2e/burn-in-smoke.spec.ts')
}

describe('isE2eSpec / isE2eSupportFile', () => {
  it.each([
    ['e2e/smoke.spec.ts', true],
    ['e2e/nested/foo.spec.ts', true],
    ['e2e/helpers/wait.ts', false],
    ['e2e/burn-in-fixtures/timing-dependent.spec.ts', false],
    ['src/app.ts', false],
  ])('spec %s → %s', (path, expected) => {
    expect(isE2eSpec(path)).toBe(expected)
  })

  it.each([
    ['e2e/helpers/wait.ts', true],
    ['e2e/helpers/nested/x.mjs', true],
    ['e2e/fixtures/wait.ts', true],
    ['e2e/perf/budgets.ts', true],
    ['e2e/smoke.spec.ts', false],
    ['e2e/burn-in-fixtures/timing-dependent.spec.ts', false],
    ['e2e/fixtures/sample.png', false],
  ])('support %s → %s', (path, expected) => {
    expect(isE2eSupportFile(path)).toBe(expected)
  })
})

describe('extractRelativeImports', () => {
  it('finds from/import/require forms', () => {
    expect(
      extractRelativeImports(`import { x } from './fixtures/x'\n`),
    ).toEqual(['./fixtures/x'])
    expect(extractRelativeImports(`import './fixtures/side'\n`)).toEqual([
      './fixtures/side',
    ])
    expect(
      extractRelativeImports(`const x = require('./fixtures/b')\n`),
    ).toEqual(['./fixtures/b'])
    expect(
      extractRelativeImports(`export { x } from './fixtures/a'\n`),
    ).toEqual(['./fixtures/a'])
  })
})

describe('resolveE2eImport', () => {
  it('resolves extension and index variants', () => {
    const exists = (path) =>
      path === 'e2e/fixtures/open.ts' ||
      path === 'e2e/helpers/nested/x/index.ts'
    expect(
      resolveE2eImport('e2e/a.spec.ts', './fixtures/open', { exists }),
    ).toBe('e2e/fixtures/open.ts')
    expect(
      resolveE2eImport('e2e/a.spec.ts', './helpers/nested/x', { exists }),
    ).toBe('e2e/helpers/nested/x/index.ts')
  })

  it('returns null when missing or outside e2e/', () => {
    expect(
      resolveE2eImport('e2e/a.spec.ts', './fixtures/missing', {
        exists: () => false,
      }),
    ).toBeNull()
    expect(
      resolveE2eImport('e2e/a.spec.ts', '../../src/x', {
        exists: () => true,
      }),
    ).toBeNull()
  })
})

describe('listE2eSourceFiles', () => {
  it('walks a temp e2e tree and skips burn-in-fixtures', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-in-list-'))
    mkdirSync(join(root, 'e2e/fixtures'), { recursive: true })
    mkdirSync(join(root, 'e2e/burn-in-fixtures'), { recursive: true })
    writeFileSync(join(root, 'e2e/a.spec.ts'), '')
    writeFileSync(join(root, 'e2e/fixtures/open.ts'), '')
    writeFileSync(join(root, 'e2e/burn-in-fixtures/timing.spec.ts'), '')
    writeFileSync(join(root, 'e2e/fixtures/sample.png'), '')
    expect(listE2eSourceFiles(root)).toEqual([
      'e2e/a.spec.ts',
      'e2e/fixtures/open.ts',
    ])
  })

  it('returns empty when e2e is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-in-nolist-'))
    expect(listE2eSourceFiles(root)).toEqual([])
  })

  it('swallows readdir errors mid-walk', () => {
    let calls = 0
    expect(
      listE2eSourceFiles('/repo', {
        exists: (path) => path === join('/repo', 'e2e') || path === '/repo/e2e',
        readdir: () => {
          calls += 1
          if (calls === 1) {
            return [
              { name: 'bad', isDirectory: () => true, isFile: () => false },
            ]
          }
          throw new Error('boom')
        },
      }),
    ).toEqual([])
  })
})

describe('selectBurnInTargets', () => {
  it('includes changed specs in sorted order', () => {
    expect(
      selectBurnInTargets(
        ['e2e/z.spec.ts', 'e2e/a.spec.ts', 'src/main.tsx', 'e2e/a.spec.ts'],
        {
          listSources: () => [],
          flakyPaths: [],
        },
      ),
    ).toEqual(['e2e/a.spec.ts', 'e2e/z.spec.ts'])
  })

  it('excludes paths listed in flakyPaths', () => {
    expect(
      selectBurnInTargets(['e2e/a.spec.ts', 'e2e/b.spec.ts'], {
        listSources: () => [],
        flakyPaths: ['e2e/b.spec.ts'],
      }),
    ).toEqual(['e2e/a.spec.ts'])
  })

  it('fixture change pulls in its importers', () => {
    const files = {
      'e2e/a.spec.ts': `import { open } from './fixtures/open'\n`,
      'e2e/b.spec.ts': `import { other } from './fixtures/other'\n`,
      'e2e/fixtures/open.ts': `export const open = 1\n`,
      'e2e/fixtures/other.ts': `export const other = 1\n`,
    }
    const paths = Object.keys(files)
    expect(
      selectBurnInTargets(['e2e/fixtures/open.ts'], {
        listSources: () => paths,
        readFile: (path) => files[path],
        exists: (path) => path in files,
      }),
    ).toEqual(['e2e/a.spec.ts'])
  })

  it('nested helper path matches full resolved import', () => {
    const files = {
      'e2e/a.spec.ts': `import { x } from './helpers/nested/x'\n`,
      'e2e/helpers/nested/x.ts': `export const x = 1\n`,
    }
    expect(
      selectBurnInTargets(['e2e/helpers/nested/x.ts'], {
        listSources: () => Object.keys(files),
        readFile: (path) => files[path],
        exists: (path) => path in files,
      }),
    ).toEqual(['e2e/a.spec.ts'])
  })

  it('transitive import through another e2e support file', () => {
    const files = {
      'e2e/a.spec.ts': `import { a } from './fixtures/a'\n`,
      'e2e/fixtures/a.ts': `import { b } from './b'\nexport const a = b\n`,
      'e2e/fixtures/b.ts': `export const b = 1\n`,
    }
    expect(
      selectBurnInTargets(['e2e/fixtures/b.ts'], {
        listSources: () => Object.keys(files),
        readFile: (path) => files[path],
        exists: (path) => path in files,
      }),
    ).toEqual(['e2e/a.spec.ts'])
  })

  it('same-leaf file in another folder does not match', () => {
    const files = {
      'e2e/a.spec.ts': `import { wait } from './helpers/wait'\n`,
      'e2e/helpers/wait.ts': `export const wait = 1\n`,
      'e2e/fixtures/wait.ts': `export const wait = 2\n`,
    }
    expect(
      selectBurnInTargets(['e2e/fixtures/wait.ts'], {
        listSources: () => Object.keys(files),
        readFile: (path) => files[path],
        exists: (path) => path in files,
      }),
    ).toEqual([])
  })

  it('deleted support file does not crash', () => {
    const files = {
      'e2e/a.spec.ts': `import { wait } from './helpers/wait'\n`,
    }
    expect(() =>
      selectBurnInTargets(['e2e/helpers/gone.ts'], {
        listSources: () => Object.keys(files),
        readFile: (path) => {
          if (!(path in files)) throw new Error('missing')
          return files[path]
        },
        exists: (path) => path in files,
      }),
    ).not.toThrow()
    expect(
      selectBurnInTargets(['e2e/helpers/gone.ts'], {
        listSources: () => Object.keys(files),
        readFile: (path) => files[path],
        exists: (path) => path in files,
      }),
    ).toEqual([])
  })

  it('returns empty when nothing relevant changed', () => {
    expect(
      selectBurnInTargets(['README.md'], {
        listSources: () => ['e2e/a.spec.ts'],
      }),
    ).toEqual([])
  })

  it('keeps changed specs when listSources throws', () => {
    expect(
      selectBurnInTargets(['e2e/a.spec.ts', 'e2e/fixtures/open.ts'], {
        listSources: () => {
          throw new Error('list failed')
        },
      }),
    ).toEqual(['e2e/a.spec.ts'])
  })

  it('skips unreadable sources in the graph', () => {
    expect(
      selectBurnInTargets(['e2e/fixtures/open.ts'], {
        listSources: () => ['e2e/a.spec.ts', 'e2e/fixtures/open.ts'],
        readFile: (path) => {
          if (path === 'e2e/a.spec.ts') throw new Error('unreadable')
          return 'export const open = 1\n'
        },
        exists: () => true,
      }),
    ).toEqual([])
  })

  it('buildImportGraph only keeps resolved imports that are known files', () => {
    const files = {
      'e2e/a.spec.ts': `import { a } from './fixtures/a'\nimport { x } from './fixtures/outside'\n`,
      'e2e/fixtures/a.ts': `export const a = 1\n`,
    }
    const exists = (path) => path in files || path === 'e2e/fixtures/outside.ts'
    const graph = buildImportGraph(Object.keys(files), {
      readFile: (path) => files[path],
      exists,
    })
    expect([...graph.get('e2e/a.spec.ts')]).toEqual(['e2e/fixtures/a.ts'])
  })

  it('buildImportGraph records empty imports for unreadable files', () => {
    const graph = buildImportGraph(['e2e/a.spec.ts'], {
      readFile: () => {
        throw new Error('unreadable')
      },
      exists: () => true,
    })
    expect(graph.has('e2e/a.spec.ts')).toBe(true)
    expect([...graph.get('e2e/a.spec.ts')]).toEqual([])
  })

  it('buildImportGraph and transitiveImports walk edges', () => {
    const files = {
      'e2e/a.spec.ts': `import { a } from './fixtures/a'\n`,
      'e2e/fixtures/a.ts': `import { b } from './b'\n`,
      'e2e/fixtures/b.ts': `export const b = 1\n`,
    }
    const graph = buildImportGraph(Object.keys(files), {
      readFile: (path) => files[path],
      exists: (path) => path in files,
    })
    expect([...transitiveImports('e2e/a.spec.ts', graph)].sort()).toEqual([
      'e2e/fixtures/a.ts',
      'e2e/fixtures/b.ts',
    ])
    expect([...transitiveImports('missing', graph)]).toEqual([])
  })

  it('listE2eSourceFiles returns sorted paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-in-sort-'))
    mkdirSync(join(root, 'e2e'), { recursive: true })
    writeFileSync(join(root, 'e2e/z.spec.ts'), '')
    writeFileSync(join(root, 'e2e/a.spec.ts'), '')
    expect(listE2eSourceFiles(root)).toEqual(['e2e/a.spec.ts', 'e2e/z.spec.ts'])
  })

  it('listE2eSourceFiles sorts even when readdir is reverse', () => {
    const e2eDir = join('/repo', 'e2e')
    expect(
      listE2eSourceFiles('/repo', {
        exists: (path) => path === e2eDir,
        readdir: () => [
          { name: 'z.spec.ts', isDirectory: () => false },
          { name: 'm.spec.ts', isDirectory: () => false },
          { name: 'a.spec.ts', isDirectory: () => false },
        ],
      }),
    ).toEqual(['e2e/a.spec.ts', 'e2e/m.spec.ts', 'e2e/z.spec.ts'])
  })
})

describe('gitLines / collectChangedPaths', () => {
  it('parses git stdout lines', () => {
    expect(
      gitLines(['status'], {
        spawnSync: () => ({ status: 0, stdout: 'a\n\nb\n', stderr: '' }),
      }),
    ).toEqual(['a', 'b'])
  })

  it('treats null stdout/stderr as empty', () => {
    expect(
      gitLines(['status'], {
        spawnSync: () => ({ status: 0, stdout: null, stderr: null }),
      }),
    ).toEqual([])
    expect(() =>
      gitLines(['status'], {
        spawnSync: () => ({ status: 1, stdout: null, stderr: null }),
      }),
    ).toThrow('git status failed')
  })

  it('trims git stdout lines', () => {
    expect(
      gitLines(['status'], {
        spawnSync: () => ({
          status: 0,
          stdout: '  spaced  \n\n  other  \n',
          stderr: null,
        }),
      }),
    ).toEqual(['spaced', 'other'])
  })

  it('gitLines default spawnSync talks to real git', () => {
    const lines = gitLines(['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(lines).toEqual([expect.stringMatching(/^[^\s]+$/)])
  })

  it('throws when git fails', () => {
    expect(() =>
      gitLines(['status'], {
        spawnSync: () => ({ status: 1, stdout: '', stderr: '  boom  \n' }),
      }),
    ).toThrow('boom')
    expect(() =>
      gitLines(['status'], {
        spawnSync: () => ({ status: 2, stdout: '', stderr: '   \n' }),
      }),
    ).toThrow('git status failed')
    expect(() =>
      gitLines(['diff', '--name-only'], {
        spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      }),
    ).toThrow('git diff --name-only failed')
  })

  it('collectChangedPaths merges three lists with exact git argv', () => {
    const calls = []
    expect(
      collectChangedPaths('origin/main', {
        gitLines: (args) => {
          calls.push([...args])
          return [`from:${args.at(-1)}`]
        },
      }),
    ).toEqual([
      'from:origin/main',
      'from:origin/main',
      'from:--exclude-standard',
    ])
    expect(calls).toEqual([
      ['diff', '--name-only', '--diff-filter=ACMR', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=ACMR', '--cached', 'origin/main'],
      ['ls-files', '--others', '--exclude-standard'],
    ])
  })

  it('collectChangedPaths defaults base from env then origin/main', () => {
    const calls = []
    const prev = process.env.STRYKER_DIFF_BASE
    delete process.env.STRYKER_DIFF_BASE
    collectChangedPaths(undefined, {
      gitLines: (args) => {
        calls.push(args.at(-1))
        return []
      },
    })
    expect(calls[0]).toBe('origin/main')
    process.env.STRYKER_DIFF_BASE = 'origin/feature'
    calls.length = 0
    collectChangedPaths(undefined, {
      gitLines: (args) => {
        calls.push(args.at(-1))
        return []
      },
    })
    expect(calls[0]).toBe('origin/feature')
    restoreStrykerDiffBase(prev)
  })

  it('collectChangedPaths uses real gitLines when io.gitLines omitted', () => {
    const paths = collectChangedPaths('HEAD')
    expect(Array.isArray(paths)).toBe(true)
  })

  it('transitiveImports tolerates missing graph nodes', () => {
    const graph = new Map([['a', new Set(['b'])]])
    expect([...transitiveImports('a', graph)]).toEqual(['b'])
  })
})

describe('real repo defaults', () => {
  it('resolveE2eImport and buildImportGraph use filesystem', () => {
    expect(
      resolveE2eImport(
        'e2e/filmstrip.spec.ts',
        './fixtures/ensurePhotoFixtures',
      ),
    ).toBe('e2e/fixtures/ensurePhotoFixtures.ts')
    const graph = buildImportGraph([
      'e2e/filmstrip.spec.ts',
      'e2e/fixtures/ensurePhotoFixtures.ts',
    ])
    expect(
      graph
        .get('e2e/filmstrip.spec.ts')
        ?.has('e2e/fixtures/ensurePhotoFixtures.ts'),
    ).toBe(true)
  })

  it('fixture change selects real importers via default listSources', () => {
    const targets = selectBurnInTargets(['e2e/fixtures/ensurePhotoFixtures.ts'])
    expect(targets).toContain('e2e/filmstrip.spec.ts')
    expect(targets.every((path) => isE2eSpec(path))).toBe(true)
  })

  it('listE2eSourceFiles walks the repo e2e tree', () => {
    const files = listE2eSourceFiles(process.cwd())
    expect(files).toContain('e2e/burn-in-smoke.spec.ts')
    expect(files).toContain('e2e/fixtures/ensurePhotoFixtures.ts')
    expect(files.some((path) => path.startsWith('e2e/burn-in-fixtures/'))).toBe(
      false,
    )
  })
})

describe('main CLI', () => {
  it('prints targets and filters missing files', () => {
    let out = ''
    const code = main(
      { STRYKER_DIFF_BASE: 'origin/main' },
      {
        gitLines: () => ['e2e/smoke.spec.ts', 'e2e/missing.spec.ts'],
        exists: (path) => path === 'e2e/smoke.spec.ts',
        isFile: (path) => path === 'e2e/smoke.spec.ts',
        listSources: () => ['e2e/smoke.spec.ts'],
        readFile: () => '',
        write: (text) => {
          out += text
        },
      },
    )
    expect(code).toBe(0)
    expect(out).toBe('e2e/smoke.spec.ts\n')
  })

  it('uses default exists/isFile/write against a real spec', () => {
    let out = ''
    const code = main(
      {},
      {
        gitLines: () => ['e2e/burn-in-smoke.spec.ts'],
        write: (text) => {
          out += text
        },
      },
    )
    expect(code).toBe(0)
    expect(out).toBe('e2e/burn-in-smoke.spec.ts\n')
  })

  it('default isFile returns false when exists lies about missing path', () => {
    let out = ''
    const code = main(
      {},
      {
        gitLines: () => ['e2e/does-not-exist.spec.ts'],
        exists: () => true,
        write: (text) => {
          out += text
        },
      },
    )
    expect(code).toBe(0)
    expect(out).toBe('')
  })

  it('exits quietly when no targets', () => {
    let out = ''
    const code = main(
      {},
      {
        gitLines: () => ['README.md'],
        listSources: () => [],
        write: (text) => {
          out += text
        },
      },
    )
    expect(code).toBe(0)
    expect(out).toBe('')
  })

  it('returns 1 when collectChangedPaths throws', () => {
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

  it('default error writer handles non-Error throws', () => {
    const code = main(
      {},
      {
        gitLines: () => {
          throw 'git down'
        },
      },
    )
    expect(code).toBe(1)
  })

  it('spawned CLI prints targets from injected-equivalent git base', () => {
    runSpawnedCliBurnInTargets()
  })
})
