import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  listSrcProductionFiles,
  runMutationScopeCheck,
} from './check-mutation-scope.mjs'
import { classifyMutationFile, loadMutatePatterns } from './mutation-scope.mjs'
import { stripGitKeys } from './strip-git-env.mjs'

const ROOT = resolveRepoRoot()

describe('check-mutation-scope', () => {
  it('real mutate patterns scope src and exclude scripts', () => {
    const patterns = loadMutatePatterns()
    expect(classifyMutationFile('src/core/book.ts', patterns)).toBe('in-scope')
    expect(classifyMutationFile('scripts/agent.mjs', patterns)).toBe(
      'unclassified',
    )
    expect(classifyMutationFile('src/main.tsx', patterns)).toBe('excluded')
  })

  it('unclassified src file fails the checker', () => {
    const errors = []
    const code = runMutationScopeCheck({
      patterns: ['src/**/*.ts'],
      srcFiles: ['src/orphan.tsx'],
      reasonText: '',
      gates: { mutation: { temporaryExcludes: [] } },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors.some((m) => m.includes('src/orphan.tsx'))).toBe(true)
  })

  it('reports missing exclude reasons, extras, and temp bang gaps', () => {
    const errors = []
    const code = runMutationScopeCheck({
      patterns: ['src/**/*.ts', '!src/orphan.ts'],
      srcFiles: [],
      reasonText: '- `!src/other.ts` — x\n',
      gates: {
        mutation: {
          temporaryExcludes: [{ path: 'src/orphan.ts' }],
        },
      },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors.some((m) => m.includes('missing a reason'))).toBe(true)
    expect(errors.some((m) => m.includes('documents excludes'))).toBe(true)
  })

  it('reports temporaryExcludes missing bangs', () => {
    const errors = []
    const code = runMutationScopeCheck({
      patterns: ['src/**/*.ts'],
      srcFiles: [],
      reasonText: '',
      gates: {
        mutation: {
          temporaryExcludes: [{ path: 'src/no-bang.ts' }],
        },
      },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors.some((m) => m.includes('temporaryExcludes'))).toBe(true)
  })

  it('uses default gates.mutation when omitted', () => {
    const code = runMutationScopeCheck({
      patterns: ['src/a.ts'],
      srcFiles: ['src/a.ts'],
      reasonText: '',
      gates: {},
      error: () => {},
      log: () => {},
    })
    expect(code).toBe(0)
  })

  it('repo src files pass mutation-scope against real config', () => {
    const code = runMutationScopeCheck({
      log: () => {},
      error: () => {},
    })
    expect(code).toBe(0)
  })

  it('CLI entry exits 0 on the real repo', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'packages/ts-agent-rig/src/check-mutation-scope.mjs')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: stripGitKeys({ ...process.env }),
      },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/src production files/)
  })

  it('listSrcProductionFiles filters ts/tsx only', () => {
    const files = listSrcProductionFiles()
    expect(files.every((f) => f.endsWith('.ts') || f.endsWith('.tsx'))).toBe(
      true,
    )
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true)
  })

  it('emits only the failing sections with exact prefixes', () => {
    const errors = []
    const code = runMutationScopeCheck({
      patterns: ['src/**/*.ts', '!src/x.ts'],
      srcFiles: [],
      reasonText: '',
      gates: { mutation: { temporaryExcludes: [] } },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe(
      'Exclude patterns missing a reason in stryker.mutate.md:\n!src/x.ts',
    )
  })

  it('emits extra reason docs without unclassified noise', () => {
    const errors = []
    runMutationScopeCheck({
      patterns: ['src/a.ts'],
      srcFiles: ['src/a.ts'],
      reasonText: '- `!src/ghost.ts` — gone\n',
      gates: { mutation: { temporaryExcludes: [] } },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(errors).toEqual([
      'stryker.mutate.md documents excludes that are not in stryker.config.mjs:\n!src/ghost.ts',
    ])
  })

  it('emits temp bang gaps with exact prefix', () => {
    const errors = []
    runMutationScopeCheck({
      patterns: ['src/a.ts'],
      srcFiles: ['src/a.ts'],
      reasonText: '',
      gates: {
        mutation: { temporaryExcludes: [{ path: 'src/no-bang.ts' }] },
      },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(errors).toEqual([
      'mutation.temporaryExcludes paths missing exact ! bang in stryker.config.mjs:\nsrc/no-bang.ts',
    ])
  })

  it('treats non-array temporaryExcludes as empty', () => {
    const errors = []
    const code = runMutationScopeCheck({
      patterns: ['src/a.ts'],
      srcFiles: ['src/a.ts'],
      reasonText: '',
      gates: { mutation: { temporaryExcludes: /** @type {any} */ ('nope') } },
      error: (msg) => errors.push(msg),
      log: () => {},
    })
    expect(code).toBe(0)
    expect(errors).toEqual([])
  })

  it('success log names src count', () => {
    const logs = []
    const code = runMutationScopeCheck({
      patterns: ['src/**/*.ts'],
      srcFiles: ['src/a.ts'],
      reasonText: '',
      gates: { mutation: {} },
      error: () => {},
      log: (msg) => logs.push(msg),
    })
    expect(code).toBe(0)
    expect(logs).toEqual(['Mutation scope covers 1 src production files.'])
  })
})
