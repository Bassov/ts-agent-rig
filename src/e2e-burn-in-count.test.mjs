import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  findRoadmapItemPath,
  main,
  parseBurnInLine,
  resolveBurnInCount,
  slugFromBranch,
} from './e2e-burn-in-count.mjs'

describe('parseBurnInLine', () => {
  it('reads Burn-in: N', () => {
    expect(parseBurnInLine('# title\n\nBurn-in: 50\n')).toBe(50)
  })

  it('returns null when absent', () => {
    expect(parseBurnInLine('# title\n')).toBeNull()
  })

  it('parses Burn-in: 0 (caller still ignores via resolve)', () => {
    expect(parseBurnInLine('Burn-in: 0\n')).toBe(0)
  })
})

describe('slugFromBranch', () => {
  it.each([
    ['feat/e2e-burn-in', 'e2e-burn-in'],
    ['fix/foo-bar', 'foo-bar'],
    ['docs/m21', null],
    ['main', null],
    [null, null],
    ['  feat/x-y  ', 'x-y'],
  ])('%s → %s', (branch, slug) => {
    expect(slugFromBranch(branch)).toBe(slug)
  })
})

describe('findRoadmapItemPath', () => {
  it('finds slug under docs/roadmap and skips archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-in-count-'))
    mkdirSync(join(root, 'docs/roadmap/M2.1'), { recursive: true })
    mkdirSync(join(root, 'docs/roadmap/M2.2'), { recursive: true })
    mkdirSync(join(root, 'docs/roadmap/archive'), { recursive: true })
    writeFileSync(
      join(root, 'docs/roadmap/M2.2/e2e-burn-in.md'),
      'Burn-in: 50\n',
    )
    writeFileSync(
      join(root, 'docs/roadmap/archive/e2e-burn-in.md'),
      'Burn-in: 99\n',
    )
    const found = findRoadmapItemPath(root, 'e2e-burn-in')
    expect(found).toBe(join(root, 'docs/roadmap/M2.2/e2e-burn-in.md'))
    expect(found).toContain(`${join('docs', 'roadmap')}`)
    expect(findRoadmapItemPath(root, 'missing')).toBeNull()
    expect(findRoadmapItemPath(root, null)).toBeNull()
    expect(findRoadmapItemPath(root, '')).toBeNull()
    expect(findRoadmapItemPath(join(root, 'nope'), 'e2e-burn-in')).toBeNull()
  })

  it('does not resolve items that only exist under archive/', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-in-archive-only-'))
    mkdirSync(join(root, 'docs/roadmap/archive'), { recursive: true })
    mkdirSync(join(root, 'docs/roadmap/M2.1'), { recursive: true })
    writeFileSync(
      join(root, 'docs/roadmap/archive/only-archived.md'),
      'Burn-in: 99\n',
    )
    expect(findRoadmapItemPath(root, 'only-archived')).toBeNull()
  })
})

describe('resolveBurnInCount', () => {
  it('defaults to 10', () => {
    expect(resolveBurnInCount({ env: {}, branch: null })).toBe(10)
  })

  it('treats empty E2E_BURN_IN as default 10', () => {
    expect(resolveBurnInCount({ env: { E2E_BURN_IN: '' }, branch: null })).toBe(
      10,
    )
  })

  it('uses E2E_BURN_IN', () => {
    expect(
      resolveBurnInCount({ env: { E2E_BURN_IN: '12' }, branch: null }),
    ).toBe(12)
  })

  it('overrides with higher Burn-in from roadmap item', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10' },
        branch: 'feat/e2e-burn-in',
        findItemPath: () => '/repo/docs/roadmap/M2.1/e2e-burn-in.md',
        readItemFile: () => '# x\nBurn-in: 50\n',
      }),
    ).toBe(50)
  })

  it('keeps base when Burn-in is lower', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '20' },
        branch: 'feat/e2e-burn-in',
        findItemPath: () => '/item.md',
        readItemFile: () => 'Burn-in: 5\n',
      }),
    ).toBe(20)
  })

  it('falls back when item is missing without reading', () => {
    let reads = 0
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10' },
        branch: 'feat/e2e-burn-in',
        findItemPath: () => null,
        readItemFile: () => {
          reads += 1
          return 'Burn-in: 99\n'
        },
      }),
    ).toBe(10)
    expect(reads).toBe(0)
  })

  it('does not call findItemPath when branch has no slug', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10' },
        branch: null,
        findItemPath: () => {
          throw new Error('should not call findItemPath')
        },
      }),
    ).toBe(10)
  })

  it('accepts E2E_BURN_IN of 1', () => {
    expect(
      resolveBurnInCount({ env: { E2E_BURN_IN: '1' }, branch: null }),
    ).toBe(1)
  })

  it('ignores Burn-in: 0 and keeps base', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10' },
        branch: 'feat/e2e-burn-in',
        findItemPath: () => '/item.md',
        readItemFile: () => 'Burn-in: 0\n',
      }),
    ).toBe(10)
  })

  it('throws on invalid E2E_BURN_IN', () => {
    expect(() =>
      resolveBurnInCount({ env: { E2E_BURN_IN: '0' }, branch: null }),
    ).toThrow(/positive integer/)
    expect(() =>
      resolveBurnInCount({ env: { E2E_BURN_IN: 'nope' }, branch: null }),
    ).toThrow(/positive integer/)
  })

  it('falls back when item file cannot be read', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10' },
        branch: 'feat/e2e-burn-in',
        findItemPath: () => '/item.md',
        readItemFile: () => {
          throw new Error('io')
        },
      }),
    ).toBe(10)
  })

  it('uses GITHUB_HEAD_REF when branch omitted', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10', GITHUB_HEAD_REF: 'feat/e2e-burn-in' },
        findItemPath: () => '/item.md',
        readItemFile: () => 'Burn-in: 50\n',
      }),
    ).toBe(50)
  })

  it('uses GITHUB_REF_NAME when HEAD_REF absent', () => {
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10', GITHUB_REF_NAME: 'feat/e2e-burn-in' },
        findItemPath: () => '/item.md',
        readItemFile: () => 'Burn-in: 40\n',
      }),
    ).toBe(40)
  })

  it('resolves against a real roadmap tree with a unique slug', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-in-resolve-'))
    mkdirSync(join(root, 'docs/roadmap/M2.1'), { recursive: true })
    writeFileSync(
      join(root, 'docs/roadmap/M2.1/unique-burn-in-slug.md'),
      'Burn-in: 77\n',
    )
    expect(
      resolveBurnInCount({
        env: { E2E_BURN_IN: '10' },
        branch: 'feat/unique-burn-in-slug',
        root,
      }),
    ).toBe(77)
  })
})

describe('main CLI', () => {
  it('prints resolved count', () => {
    let out = ''
    const code = main({
      env: { E2E_BURN_IN: '7' },
      branch: null,
      write: (text) => {
        out += text
      },
    })
    expect(code).toBe(0)
    expect(out).toBe('7\n')
  })

  it('writes to stdout when write is omitted', () => {
    const chunks = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(String(chunk))
      return original(chunk, ...rest)
    }
    try {
      const code = main({ env: { E2E_BURN_IN: '4' }, branch: null })
      expect(code).toBe(0)
      expect(chunks.join('')).toContain('4\n')
    } finally {
      process.stdout.write = original
    }
  })

  it('spawned CLI entry prints an integer', () => {
    const out = execFileSync(
      process.execPath,
      [join(process.cwd(), 'packages/ts-agent-rig/src/e2e-burn-in-count-cli.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, E2E_BURN_IN: '9', GITHUB_HEAD_REF: '' },
      },
    )
    expect(out.trim()).toBe('9')
  })

  it('spawned CLI surfaces resolve errors', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [join(process.cwd(), 'packages/ts-agent-rig/src/e2e-burn-in-count-cli.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, E2E_BURN_IN: '0', GITHUB_HEAD_REF: '' },
        },
      ),
    ).toThrow(/positive integer/)
  })
})
