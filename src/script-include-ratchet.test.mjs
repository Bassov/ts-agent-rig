import { describe, expect, it } from 'vitest'
import {
  codecovFlagPathCovered,
  compareScriptScopeGates,
  coverageIncludeCovered,
  hasScriptsCoverageInclude,
  isAllowedScriptPairedExclude,
} from './script-include-ratchet.mjs'

const thinCli = `#!/usr/bin/env node
import { main } from './agent.mjs'
main(process.argv.slice(2), process)
`

const DEFAULT_MSGS = Object.freeze({
  includeRemovedPrefix: 'coverage include removed: ',
  mutateIncludeRemovedPrefix: 'stryker mutate include removed: ',
  excludeAddedPrefix: 'coverage exclude added: ',
  bangAddedPrefix: 'stryker mutate bang added: ',
})

/**
 * @param {Partial<{
 *   extractCoverageIncludes: (c: unknown) => string[],
 *   extractCoverageExcludes: (c: unknown) => string[],
 *   extractStrykerGateBits: (c: unknown) => { mutate?: string[], bang: string[] },
 *   coerceText: (c: unknown) => string,
 *   getFile: (files: Record<string, string | undefined>, path: string) => string | undefined,
 *   msgs: typeof DEFAULT_MSGS,
 * }>} [overrides]
 */
function makeScriptScopeDeps(overrides = {}) {
  return {
    extractCoverageIncludes: (c) => {
      const m = String(c).match(/include:\s*\[([^\]]*)\]/)
      if (!m) return []
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    },
    extractCoverageExcludes: (c) => {
      const m = String(c).match(/exclude:\s*\[([^\]]*)\]/)
      if (!m) return []
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    },
    extractStrykerGateBits: (c) => ({
      mutate: [...String(c).matchAll(/'([^'!][^']*)'/g)].map((x) => x[1]),
      bang: [...String(c).matchAll(/'!([^']+)'/g)].map((x) => `!${x[1]}`),
    }),
    coerceText: (c) => String(c ?? ''),
    getFile: (files, p) => files[p],
    msgs: DEFAULT_MSGS,
    ...overrides,
  }
}

/**
 * @param {Record<string, string>} baseFiles
 * @param {Record<string, string>} headFiles
 * @param {ReturnType<typeof makeScriptScopeDeps>} [deps]
 */
function runScriptScope(baseFiles, headFiles, deps = makeScriptScopeDeps()) {
  /** @type {{ ruleId: string, message: string }[]} */
  const violations = []
  compareScriptScopeGates(
    baseFiles,
    headFiles,
    (ruleId, message) => {
      violations.push({ ruleId, message })
    },
    deps,
  )
  return violations
}

describe('script-include-ratchet helpers', () => {
  it('detects scripts coverage include globs', () => {
    expect(hasScriptsCoverageInclude(['src/**/*.{ts,tsx}'])).toBe(false)
    expect(hasScriptsCoverageInclude(['scripts/**/*.mjs'])).toBe(true)
    expect(hasScriptsCoverageInclude(['scripts/**'])).toBe(true)
  })

  it('subsumes hand-listed scripts and normalizes scripts/**', () => {
    expect(
      coverageIncludeCovered('scripts/agent.mjs', ['scripts/**/*.mjs']),
    ).toBe(true)
    expect(coverageIncludeCovered('scripts/**', ['scripts/**/*.mjs'])).toBe(
      true,
    )
    expect(coverageIncludeCovered('scripts/**/*.mjs', ['scripts/**'])).toBe(
      true,
    )
    expect(coverageIncludeCovered('scripts/agent.mjs', ['src/**'])).toBe(false)
    expect(
      coverageIncludeCovered('scripts/agent.mjs', ['scripts/agent.mjs']),
    ).toBe(true)
  })

  it('allows only test glob and thin CLI paired excludes', () => {
    expect(
      isAllowedScriptPairedExclude('scripts/**/*.test.mjs', {}, [
        'scripts/**/*.mjs',
      ]),
    ).toBe(true)
    expect(
      isAllowedScriptPairedExclude(
        '!scripts/agent-cli.mjs',
        { 'scripts/agent-cli.mjs': thinCli },
        ['scripts/**/*.mjs'],
      ),
    ).toBe(true)
    expect(
      isAllowedScriptPairedExclude(
        '!scripts/agent-cli.mjs',
        { 'scripts/agent-cli.mjs': thinCli },
        ['src/**'],
      ),
    ).toBe(false)
    expect(
      isAllowedScriptPairedExclude('!scripts/missing.mjs', {}, [
        'scripts/**/*.mjs',
      ]),
    ).toBe(false)
    expect(
      isAllowedScriptPairedExclude('!scripts/**/*.mjs', {}, [
        'scripts/**/*.mjs',
      ]),
    ).toBe(false)
    expect(
      isAllowedScriptPairedExclude('!src/main.tsx', {}, ['scripts/**/*.mjs']),
    ).toBe(false)
  })

  it('covers codecov flag paths via directory prefix', () => {
    expect(codecovFlagPathCovered('scripts/agent.mjs', ['scripts/'])).toBe(true)
    expect(codecovFlagPathCovered('scripts/agent.mjs', ['scripts'])).toBe(true)
    expect(
      codecovFlagPathCovered('scripts/agent.mjs', ['scripts/agent.mjs']),
    ).toBe(true)
    expect(codecovFlagPathCovered('scripts/agent.mjs', ['src/'])).toBe(false)
  })

  it('compareScriptScopeGates fails when scripts glob removed', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: []`,
      },
      {
        'vite.config.ts': `coverage: { include: ['src/**'], exclude: [] }`,
        'stryker.config.mjs': `mutate: []`,
      },
      makeScriptScopeDeps({
        extractCoverageExcludes: () => [],
        extractStrykerGateBits: () => ({ mutate: [], bang: [] }),
      }),
    )
    expect(
      violations.some(
        (v) =>
          v.ruleId === 'include-removed' &&
          v.message.includes('scripts/**/*.mjs'),
      ),
    ).toBe(true)
  })

  it('fails exclude-added for non-paired new excludes', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: []`,
      },
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: ['src/secret.ts'] }`,
        'stryker.config.mjs': `mutate: ['!src/secret.ts']`,
      },
    )
    expect(
      violations.some(
        (v) =>
          v.ruleId === 'exclude-added' &&
          v.message === 'coverage exclude added: src/secret.ts',
      ),
    ).toBe(true)
    expect(
      violations.some(
        (v) =>
          v.ruleId === 'exclude-added' &&
          v.message === 'stryker mutate bang added: !src/secret.ts',
      ),
    ).toBe(true)
  })

  it('compareScriptScopeGates allows thin CLI bang with scripts glob', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/agent.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['scripts/agent.mjs']`,
      },
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: ['scripts/**/*.test.mjs', 'scripts/agent-cli.mjs'] }`,
        'stryker.config.mjs': `mutate: ['scripts/**/*.mjs', '!scripts/**/*.test.mjs', '!scripts/agent-cli.mjs']`,
        'scripts/agent-cli.mjs': thinCli,
      },
    )
    expect(violations).toEqual([])
  })

  it('subsumes hand-listed mutate entries under scripts/**/*.mjs', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/agent.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['scripts/agent.mjs']`,
      },
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['scripts/**/*.mjs']`,
      },
      makeScriptScopeDeps({ extractCoverageExcludes: () => [] }),
    )
    expect(violations).toEqual([])
  })

  it('allows removing script entries from mutate', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['scripts/agent.mjs', 'src/**/*.ts']`,
      },
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['src/**/*.ts']`,
      },
      makeScriptScopeDeps({ extractCoverageExcludes: () => [] }),
    )
    expect(
      violations.some(
        (v) =>
          v.ruleId === 'include-removed' &&
          v.message.includes('scripts/agent.mjs'),
      ),
    ).toBe(false)
  })

  it('allows dropping scripts mutate glob', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['scripts/**/*.mjs']`,
      },
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: ['src/**/*.ts']`,
      },
      makeScriptScopeDeps({ extractCoverageExcludes: () => [] }),
    )
    expect(
      violations.some(
        (v) =>
          v.ruleId === 'include-removed' &&
          v.message.includes('scripts/**/*.mjs'),
      ),
    ).toBe(false)
  })

  it('treats missing mutate field as empty (no false mutate removals)', () => {
    const violations = runScriptScope(
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: []`,
      },
      {
        'vite.config.ts': `coverage: { include: ['scripts/**/*.mjs'], exclude: [] }`,
        'stryker.config.mjs': `mutate: []`,
      },
      makeScriptScopeDeps({
        extractCoverageIncludes: () => ['scripts/**/*.mjs'],
        extractCoverageExcludes: () => [],
        // Intentionally omit `mutate` so `?? []` is exercised.
        extractStrykerGateBits: () => ({ bang: [] }),
      }),
    )
    expect(violations).toEqual([])
  })
})
