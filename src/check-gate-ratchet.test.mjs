import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { stripGitKeys } from './strip-git-env.mjs'

const REPO_ROOT = resolveRepoRoot()
import {
  FIXTURE_IDS,
  MSGS,
  NEEDLES,
  OWNER_WAIVABLE_RULE_IDS,
  QUOTE_DOUBLE,
  QUOTE_SINGLE,
  RULE_IDS,
  coerceText,
  isQuoteChar,
  analyzeWorkflowJobs,
  classifyGateSteps,
  compactWs,
  compareCodecov,
  compareDiffVsNightly,
  compareGateTrees,
  compareGatesJson,
  compareRequiredJobGates,
  compareTemporaryExcludes,
  classifyStrykerDisableLine,
  collectStrykerDisableComments,
  countIgnoreComments,
  countLegalStrykerDisablesInTree,
  countStrykerDisable,
  countStrykerDisableMainStyle,
  coveredKindsForJob,
  findNextStrykerDirective,
  indexOfIgnoreCase,
  lineContaining,
  matchKeywordAt,
  matchPrefixIgnoreCase,
  readDisableBudget,
  skipWs,
  tryParseLegalNextLineDisable,
  STRYKER_DISABLE_PER_FILE_CAP,
  STRYKER_DISABLE_REASON_MIN,
  detectGateKindsFromBlob,
  dig,
  isRecord,
  isWsChar,
  extractCoverageExcludes,
  extractCoverageIncludes,
  extractFirstKeyedArray,
  extractQuotedStrings,
  extractStrykerGateBits,
  getFile,
  indexOfToolIgnore,
  isBurnInRun,
  isE2eStep,
  isIdentContinue,
  isWorkflowYmlPath,
  jobsProvidingKind,
  listSourcePaths,
  numberWeaker,
  parseArgs,
  parseExportedStringArray,
  parsePercentish,
  readTreeFromDir,
  readTreeFromGitRef,
  resolvePrPolicyBaseRef,
  runFailsOnNeeds,
  runGateRatchetCli,
  runPrPolicyCheck,
  sliceCoverageConfigBlock,
  stripShellComments,
} from './check-gate-ratchet.mjs'
import { gitExec, initTmpRepo } from './git-test-helper.mjs'
import {
  codecovFlagPathCovered,
  coverageIncludeCovered,
  hasScriptsCoverageInclude,
  isAllowedScriptPairedExclude,
} from './script-include-ratchet.mjs'
import { parse as parseYaml } from 'yaml'

const tmpDirs = []

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ratchet-'))
  tmpDirs.push(d)
  return d
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

/** Stable source text (not the Stryker-instrumented on-disk file). */
function scriptWithIds(ruleIds = RULE_IDS, fixtureIds = FIXTURE_IDS) {
  const q = (ids) => ids.map((id) => `  '${id}',`).join('\n')
  return `export const RULE_IDS = Object.freeze([\n${q(ruleIds)}\n])
export const FIXTURE_IDS = Object.freeze([\n${q(fixtureIds)}\n])
`
}

const baseGates = {
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
  mutation: {
    disableBudget: 0,
    temporaryExcludes: [
      {
        path: 'src/editor/projectSession.ts',
        until: 'project-session-mutation',
      },
    ],
  },
  lighthouse: {
    numberOfRuns: 1,
    assertions: { 'performance-budget': 'error' },
    budgets: [
      {
        path: '/*',
        resourceSizes: [{ resourceType: 'script', budget: 350 }],
        resourceCounts: [],
      },
    ],
  },
  playwright: { retries: 0, flakyRetries: 2 },
  e2e: { burnInDefault: 10, flakySpecs: [] },
  requiredCheckJobs: ['checks', 'integration', 'lighthouse', 'stryker-diff'],
}

/** @param {number} budget */
function gatesWithBudget(budget) {
  return JSON.stringify({
    ...baseGates,
    mutation: {
      ...baseGates.mutation,
      disableBudget: budget,
    },
  })
}

const LEGAL_DISABLE =
  '// Stryker disable next-line BooleanLiteral: justified reason ok\n'

const baseVite = `
export const coverageExcludeGlobs = ['src/**/*.d.ts'] as const
export default {
  test: {
    allowOnly: false,
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/agent.mjs'],
      exclude: [...coverageExcludeGlobs],
    },
  },
}
`

const basePlaywright = `
export default {
  forbidOnly: true,
  retries: 0,
}
`

const baseStryker = `
const config = {
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
}
export default config
`

const baseCodecov = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
flags:
  unit:
    paths:
      - src/
ignore:
  - e2e/**
`

const basePkg = JSON.stringify(
  { name: 't', pnpm: { patchedDependencies: { 'a@1': 'patches/a.patch' } } },
  null,
  2,
)

function baseFiles(overrides = {}) {
  const ratchetScript = scriptWithIds()
  /** @type {Record<string, string>} */
  const files = {
    'quality/gates.json': JSON.stringify(baseGates),
    'codecov.yml': baseCodecov,
    'vite.config.ts': baseVite,
    'playwright.config.ts': basePlaywright,
    'stryker.config.mjs': baseStryker,
    'package.json': basePkg,
    'scripts/check-gate-ratchet.mjs': ratchetScript,
    'scripts/check-gate-ratchet.test.mjs': `export const FIXTURE_IDS = Object.freeze([${FIXTURE_IDS.map((id) => `'${id}'`).join(',')}])\n`,
    '.github/workflows/integration.yml': `
jobs:
  e2e-burn-in:
    steps:
      - name: E2E burn-in
        run: pnpm exec playwright test --repeat-each=10
  e2e:
    steps:
      - name: E2E
        run: pnpm test:e2e
  integration:
    needs: [e2e, e2e-burn-in]
    steps:
      - name: Require e2e and burn-in
        run: |
          if [ "$E2E_RESULT" != "success" ]; then exit 1; fi
          if [ "$BURN_IN_RESULT" != "success" ]; then exit 1; fi
`,
    '.github/workflows/checks.yml': `
jobs:
  checks:
    steps:
      - name: Unit and property tests
        run: pnpm test:coverage
      - name: Dependency audit
        run: pnpm audit:ci
`,
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null) delete files[k]
    else files[k] = v
  }
  return files
}

describe('FIXTURE_IDS / RULE_IDS exports', () => {
  it('lists the Done-when fixture ids', () => {
    for (const id of FIXTURE_IDS) {
      expect(typeof id).toBe('string')
    }
    expect(FIXTURE_IDS).toContain('weaker-threshold')
    expect(RULE_IDS.length).toBeGreaterThan(5)
  })

  it('parseExportedStringArray reads freeze arrays', () => {
    expect(parseExportedStringArray(scriptWithIds(), 'RULE_IDS')).toEqual([
      ...RULE_IDS,
    ])
  })
})

describe('classifyGateSteps', () => {
  it('detects burn-in', () => {
    expect(
      classifyGateSteps({
        name: 'E2E burn-in',
        run: 'pnpm exec playwright test --repeat-each=10',
      }),
    ).toContain('burn-in')
  })

  it('detects e2e, coverage, stryker, lighthouse, gitleaks, audit', () => {
    expect(classifyGateSteps({ name: 'E2E', run: 'pnpm test:e2e' })).toContain(
      'e2e',
    )
    expect(
      classifyGateSteps({ name: 'Unit', run: 'pnpm test:coverage' }),
    ).toContain('coverage')
    expect(
      classifyGateSteps({ name: 'Mutate', run: 'pnpm stryker:diff' }),
    ).toContain('stryker')
    expect(classifyGateSteps({ name: 'LH', run: 'pnpm test:lhci' })).toContain(
      'lighthouse',
    )
    expect(
      classifyGateSteps({ name: 'Secrets', run: 'gitleaks detect' }),
    ).toContain('gitleaks')
    expect(
      classifyGateSteps({ name: 'Audit', run: 'pnpm audit:ci' }),
    ).toContain('audit')
  })

  it('does not treat aggregator BURN_IN_RESULT as burn-in', () => {
    expect(
      classifyGateSteps({
        name: 'Require e2e and burn-in',
        run: 'if [ "$BURN_IN_RESULT" != "success" ]; then exit 1; fi',
      }).has('burn-in'),
    ).toBe(false)
  })
})

/**
 * Drive the real CLI (`--base-dir` / `--head-dir`) used by pr-policy proofs.
 * @param {Record<string, string>} headOverrides
 * @param {Record<string, string>} [baseOverrides]
 * @param {{ prBody?: string, branch?: string }} [cliOpts]
 */
function cliRatchet(headOverrides, baseOverrides = {}, cliOpts = {}) {
  const root = tmpDir()
  const baseTree = baseFiles(baseOverrides)
  const headTree = baseFiles({ ...baseOverrides, ...headOverrides })
  writeTree(path.join(root, 'base'), baseTree)
  writeTree(path.join(root, 'head'), headTree)
  /** @type {string[]} */
  const argv = ['--cwd', root, '--base-dir', 'base', '--head-dir', 'head']
  if (cliOpts.prBody != null) {
    argv.push('--pr-body', cliOpts.prBody)
  }
  if (cliOpts.branch != null) {
    argv.push('--branch', cliOpts.branch)
  }
  const code = runGateRatchetCli(argv)
  const result = compareGateTrees(baseTree, headTree, cliOpts)
  return { code, result }
}

describe('CLI fixture proofs (real check-gate-ratchet path)', () => {
  it('FIXTURE weaker-threshold: lowering coverage floor fails', () => {
    expect(FIXTURE_IDS).toContain('weaker-threshold')
    const headGates = {
      ...baseGates,
      coverage: { ...baseGates.coverage, lines: 70 },
    }
    const { code, result } = cliRatchet({
      'quality/gates.json': JSON.stringify(headGates),
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'gates-json-weaker'),
    ).toBe(true)
  })

  it('FIXTURE weaker-diff-threshold: lowering diffThresholds fails', () => {
    expect(FIXTURE_IDS).toContain('weaker-diff-threshold')
    const headGates = {
      ...baseGates,
      stryker: {
        ...baseGates.stryker,
        diffThresholds: { high: 90, low: 85, break: 80 },
      },
    }
    const { code, result } = cliRatchet({
      'quality/gates.json': JSON.stringify(headGates),
    })
    expect(code).toBe(1)
    expect(
      result.violations.some(
        (v) =>
          v.ruleId === 'gates-json-weaker' &&
          /diffThresholds\.break/.test(v.message),
      ),
    ).toBe(true)
  })

  it('FIXTURE diff-below-nightly: diff break under nightly fails', () => {
    expect(FIXTURE_IDS).toContain('diff-below-nightly')
    const headGates = {
      ...baseGates,
      stryker: {
        thresholds: { high: 80, low: 60, break: 60 },
        diffThresholds: { high: 90, low: 85, break: 50 },
      },
    }
    const { code, result } = cliRatchet({
      'quality/gates.json': JSON.stringify(headGates),
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'diff-below-nightly'),
    ).toBe(true)
  })

  it('FIXTURE temporary-excludes-grew: new temp path fails', () => {
    expect(FIXTURE_IDS).toContain('temporary-excludes-grew')
    const headGates = {
      ...baseGates,
      mutation: {
        disableBudget: 0,
        temporaryExcludes: [
          ...baseGates.mutation.temporaryExcludes,
          { path: 'src/new/Excluded.ts', until: 'never' },
        ],
      },
    }
    const { code, result } = cliRatchet({
      'quality/gates.json': JSON.stringify(headGates),
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'temporary-excludes-grew'),
    ).toBe(true)
  })

  it('FIXTURE agent-rules-over-budget: scratch over-size fails', () => {
    expect(FIXTURE_IDS).toContain('agent-rules-over-budget')
    expect(RULE_IDS).toContain('agent-rules-over-budget')
    const gates = {
      ...baseGates,
      agentRules: {
        budgets: [{ path: 'AGENTS.md', maxLines: 1, maxChars: 2 }],
      },
    }
    const { code, result } = cliRatchet({
      'quality/gates.json': JSON.stringify(gates),
      'AGENTS.md': 'too-long-content',
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'agent-rules-over-budget'),
    ).toBe(true)
  })

  it('FIXTURE agent-rules-within-budget: matching sizes pass size rules', () => {
    expect(FIXTURE_IDS).toContain('agent-rules-within-budget')
    const text = 'ok\n'
    const gates = {
      ...baseGates,
      agentRules: {
        budgets: [
          {
            path: 'AGENTS.md',
            maxLines: 2,
            maxChars: Buffer.byteLength(text, 'utf8'),
          },
        ],
      },
    }
    const { result } = cliRatchet({
      'quality/gates.json': JSON.stringify(gates),
      'AGENTS.md': text,
    })
    expect(
      result.violations.filter((v) => v.ruleId === 'agent-rules-over-budget'),
    ).toEqual([])
    expect(
      result.violations.filter((v) => /agentRules\.budgets/.test(v.message)),
    ).toEqual([])
  })

  it('FIXTURE agent-rules-budget-raised: higher maxLines fails ratchet', () => {
    expect(FIXTURE_IDS).toContain('agent-rules-budget-raised')
    const baseWith = {
      ...baseGates,
      agentRules: {
        budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
      },
    }
    const headRaised = {
      ...baseGates,
      agentRules: {
        budgets: [{ path: 'AGENTS.md', maxLines: 9, maxChars: 50 }],
      },
    }
    const { code, result } = cliRatchet(
      {
        'quality/gates.json': JSON.stringify(headRaised),
        'AGENTS.md': 'a',
      },
      {
        'quality/gates.json': JSON.stringify(baseWith),
        'AGENTS.md': 'a',
      },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some(
        (v) =>
          v.ruleId === 'gates-json-weaker' && /maxLines raised/.test(v.message),
      ),
    ).toBe(true)
  })

  it('FIXTURE temporary-excludes-seed: base missing array allows seed', () => {
    expect(FIXTURE_IDS).toContain('temporary-excludes-seed')
    const baseNoTemp = {
      ...baseGates,
      mutation: { disableBudget: 0 },
    }
    const { code, result } = cliRatchet(
      { 'quality/gates.json': JSON.stringify(baseGates) },
      { 'quality/gates.json': JSON.stringify(baseNoTemp) },
    )
    expect(code).toBe(0)
    expect(
      result.violations.some((v) => v.ruleId === 'temporary-excludes-grew'),
    ).toBe(false)
  })

  it('FIXTURE new-exclude: new stryker bang fails', () => {
    expect(FIXTURE_IDS).toContain('new-exclude')
    const headStryker = `
const config = {
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/secret.ts'],
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
}
export default config
`
    const { code, result } = cliRatchet({ 'stryker.config.mjs': headStryker })
    expect(code).toBe(1)
    expect(result.violations.some((v) => v.ruleId === 'exclude-added')).toBe(
      true,
    )
  })

  it('FIXTURE removed-agent-include: removing scripts/agent.mjs include fails', () => {
    expect(FIXTURE_IDS).toContain('removed-agent-include')
    const headVite = `
export const coverageExcludeGlobs = ['src/**/*.d.ts'] as const
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [...coverageExcludeGlobs],
    },
  },
}
`
    const { code, result } = cliRatchet({ 'vite.config.ts': headVite })
    expect(code).toBe(1)
    expect(result.violations.some((v) => v.ruleId === 'include-removed')).toBe(
      true,
    )
    expect(
      result.violations.some((v) => v.message.includes('scripts/agent.mjs')),
    ).toBe(true)
  })

  it('Owner-approved waives include-removed / exclude-added / gate-file-gone', () => {
    expect(OWNER_WAIVABLE_RULE_IDS).toEqual(
      expect.arrayContaining([
        'include-removed',
        'exclude-added',
        'gate-file-gone',
        'temporary-excludes-grew',
      ]),
    )
    const headVite = `
export const coverageExcludeGlobs = ['src/**/*.d.ts'] as const
export default {
  test: {
    allowOnly: false,
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [...coverageExcludeGlobs],
    },
  },
}
`
    const approval = 'Owner-approved scope change: extract harness prep'
    const waived = cliRatchet(
      { 'vite.config.ts': headVite },
      {},
      { prBody: approval },
    )
    expect(waived.result.violations).toEqual([])
    expect(waived.code).toBe(0)

    const gone = cliRatchet({ 'codecov.yml': null }, {}, { prBody: approval })
    expect(
      gone.result.violations.some((v) => v.ruleId === 'gate-file-gone'),
    ).toBe(false)
    expect(gone.code).toBe(0)

    const stillFails = cliRatchet(
      {
        'src/x.test.ts': `test.skip('a', () => {})\n`,
      },
      {
        'src/x.test.ts': `test('a', () => {})\n`,
      },
      { prBody: approval },
    )
    expect(
      stillFails.result.violations.some((v) => v.ruleId === 'test-skip-added'),
    ).toBe(true)
    expect(stillFails.code).toBe(1)
  })

  it('include-removed still fails without Owner-approved', () => {
    const headVite = `
export const coverageExcludeGlobs = ['src/**/*.d.ts'] as const
export default {
  test: {
    allowOnly: false,
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [...coverageExcludeGlobs],
    },
  },
}
`
    const { code, result } = cliRatchet({ 'vite.config.ts': headVite })
    expect(result.violations.some((v) => v.ruleId === 'include-removed')).toBe(
      true,
    )
    expect(code).toBe(1)
  })

  it('FIXTURE new-excluded-mutations fails', () => {
    expect(FIXTURE_IDS).toContain('new-excluded-mutations')
    const headStryker = `
const config = {
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  mutator: { excludedMutations: ['StringLiteral'] },
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
}
export default config
`
    const { code, result } = cliRatchet({ 'stryker.config.mjs': headStryker })
    expect(code).toBe(1)
    expect(result.violations.some((v) => v.ruleId === 'stryker-weaker')).toBe(
      true,
    )
  })

  it('FIXTURE new-v8-ignore fails', () => {
    expect(FIXTURE_IDS).toContain('new-v8-ignore')
    const { code, result } = cliRatchet(
      { 'src/app.ts': '/* v8 ignore next */\nexport const x = 1\n' },
      { 'src/app.ts': 'export const x = 1\n' },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'ignore-comment-added'),
    ).toBe(true)
  })

  it('FIXTURE new-stryker-disable fails', () => {
    expect(FIXTURE_IDS).toContain('new-stryker-disable')
    const { code, result } = cliRatchet(
      { 'src/app.ts': '// Stryker disable all\nexport const x = 1\n' },
      { 'src/app.ts': 'export const x = 1\n' },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'stryker-disable-added'),
    ).toBe(true)
  })

  it('FIXTURE legal-stryker-disable-within-budget passes', () => {
    expect(FIXTURE_IDS).toContain('legal-stryker-disable-within-budget')
    const gates = gatesWithBudget(1)
    const { code, result } = cliRatchet(
      {
        'quality/gates.json': gates,
        'src/app.ts': LEGAL_DISABLE + 'export const x = 1\n',
      },
      {
        'quality/gates.json': gates,
        'src/app.ts': 'export const x = 1\n',
      },
    )
    expect(code).toBe(0)
    expect(
      result.violations.some((v) =>
        String(v.ruleId).startsWith('stryker-disable'),
      ),
    ).toBe(false)
  })

  it('FIXTURE stryker-disable-over-per-file fails', () => {
    expect(FIXTURE_IDS).toContain('stryker-disable-over-per-file')
    const gates = gatesWithBudget(4)
    const four =
      LEGAL_DISABLE +
      LEGAL_DISABLE +
      LEGAL_DISABLE +
      LEGAL_DISABLE +
      'export const x = 1\n'
    const { code, result } = cliRatchet(
      {
        'quality/gates.json': gates,
        'src/app.ts': four,
      },
      {
        'quality/gates.json': gates,
        'src/app.ts': 'export const x = 1\n',
      },
    )
    expect(code).toBe(1)
    expect(result.violations).toContainEqual({
      ruleId: 'stryker-disable-per-file',
      message: 'mutation suppression per-file cap exceeded in src/app.ts',
    })
  })

  it('exactly STRYKER_DISABLE_PER_FILE_CAP legal disables passes per-file rule', () => {
    const gates = gatesWithBudget(STRYKER_DISABLE_PER_FILE_CAP)
    const three =
      LEGAL_DISABLE + LEGAL_DISABLE + LEGAL_DISABLE + 'export const x = 1\n'
    const { code, result } = cliRatchet(
      {
        'quality/gates.json': gates,
        'src/app.ts': three,
      },
      {
        'quality/gates.json': gates,
        'src/app.ts': 'export const x = 1\n',
      },
    )
    expect(code).toBe(0)
    expect(
      result.violations.some((v) => v.ruleId === 'stryker-disable-per-file'),
    ).toBe(false)
  })

  it('FIXTURE stryker-disable-over-budget fails', () => {
    expect(FIXTURE_IDS).toContain('stryker-disable-over-budget')
    const gates = gatesWithBudget(0)
    const { code, result } = cliRatchet(
      {
        'quality/gates.json': gates,
        'src/app.ts': LEGAL_DISABLE + 'export const x = 1\n',
      },
      {
        'quality/gates.json': gates,
        'src/app.ts': 'export const x = 1\n',
      },
    )
    expect(code).toBe(1)
    expect(result.violations).toContainEqual({
      ruleId: 'stryker-disable-budget',
      message: 'mutation suppression repo budget exceeded: 1 > 0',
    })
  })

  it('allows RULE_IDS / FIXTURE_IDS to shrink without rules-superset lock', () => {
    const shrunkIds = RULE_IDS.slice(0, Math.max(1, RULE_IDS.length - 1))
    const shrunkFix = FIXTURE_IDS.slice(0, Math.max(1, FIXTURE_IDS.length - 1))
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({
        'scripts/check-gate-ratchet.mjs': scriptWithIds(shrunkIds, shrunkFix),
      }),
    )
    expect(r.violations.some((v) => v.ruleId === 'rules-superset')).toBe(false)
    expect(r.violations.some((v) => v.ruleId === 'fixtures-superset')).toBe(
      false,
    )
  })

  it('FIXTURE burn-in-moved-without-needs fails', () => {
    expect(FIXTURE_IDS).toContain('burn-in-moved-without-needs')
    const headIntegration = `
jobs:
  e2e-burn-in:
    steps:
      - name: E2E burn-in
        run: pnpm exec playwright test --repeat-each=10
  e2e:
    steps:
      - name: E2E
        run: pnpm test:e2e
  integration:
    needs: [e2e]
    steps:
      - name: Require e2e only
        run: |
          if [ "$E2E_RESULT" != "success" ]; then exit 1; fi
`
    const { code, result } = cliRatchet({
      '.github/workflows/integration.yml': headIntegration,
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'required-job-step-moved'),
    ).toBe(true)
  })

  it('FIXTURE burn-in-moved-with-needs passes for that move alone', () => {
    expect(FIXTURE_IDS).toContain('burn-in-moved-with-needs')
    const headIntegration = `
jobs:
  e2e-burn-in:
    steps:
      - name: E2E burn-in
        run: pnpm exec playwright test --repeat-each=10
  e2e:
    steps:
      - name: E2E
        run: pnpm test:e2e
  integration:
    needs: [e2e, e2e-burn-in]
    if: always()
    steps:
      - name: Require e2e and burn-in
        run: |
          if [ "$E2E_RESULT" != "success" ]; then exit 1; fi
          if [ "$BURN_IN_RESULT" != "success" ]; then exit 1; fi
`
    const { code, result } = cliRatchet({
      '.github/workflows/integration.yml': headIntegration,
    })
    expect(code).toBe(0)
    expect(
      result.violations.filter((v) => v.ruleId === 'required-job-step-moved'),
    ).toEqual([])
  })

  it('FIXTURE added-skip fails', () => {
    expect(FIXTURE_IDS).toContain('added-skip')
    const { code, result } = cliRatchet(
      { 'src/a.test.ts': `test.skip('a', () => {})\n` },
      { 'src/a.test.ts': `test('a', () => {})\n` },
    )
    expect(code).toBe(1)
    expect(result.violations.some((v) => v.ruleId === 'test-skip-added')).toBe(
      true,
    )
  })

  it('FIXTURE added-fixme fails', () => {
    expect(FIXTURE_IDS).toContain('added-fixme')
    const { code, result } = cliRatchet(
      { 'src/a.test.ts': `test.fixme('a', () => {})\n` },
      { 'src/a.test.ts': `test('a', () => {})\n` },
    )
    expect(code).toBe(1)
    expect(result.violations.some((v) => v.ruleId === 'test-skip-added')).toBe(
      true,
    )
  })

  it('FIXTURE added-retries fails', () => {
    expect(FIXTURE_IDS).toContain('added-retries')
    const { code, result } = cliRatchet(
      {
        'e2e/a.spec.ts': `test.describe.configure({ retries: 3 })\ntest('a', async () => {})\n`,
      },
      { 'e2e/a.spec.ts': `test('a', async () => {})\n` },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'test-retries-added'),
    ).toBe(true)
  })

  it('FIXTURE forbid-only-false fails', () => {
    expect(FIXTURE_IDS).toContain('forbid-only-false')
    const { code, result } = cliRatchet({
      'playwright.config.ts': `export default { forbidOnly: false }\n`,
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'forbid-only-weaker'),
    ).toBe(true)
  })

  it('FIXTURE allow-only-true fails', () => {
    expect(FIXTURE_IDS).toContain('allow-only-true')
    const { code, result } = cliRatchet({
      'vite.config.ts': baseVite.replace('allowOnly: false', 'allowOnly: true'),
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'allow-only-weaker'),
    ).toBe(true)
  })

  it('FIXTURE deleted-test-file-alone fails', () => {
    expect(FIXTURE_IDS).toContain('deleted-test-file-alone')
    const { code, result } = cliRatchet(
      {
        'src/foo.test.ts': null,
        'src/foo.ts': `export const x = 1\n`,
      },
      {
        'src/foo.test.ts': `test('a', () => {})\n`,
        'src/foo.ts': `export const x = 1\n`,
      },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'test-file-deleted'),
    ).toBe(true)
  })

  it('FIXTURE deleted-test-file-with-companion passes for that alone', () => {
    expect(FIXTURE_IDS).toContain('deleted-test-file-with-companion')
    const { code, result } = cliRatchet(
      {
        'src/foo.test.ts': null,
        'src/foo.ts': null,
      },
      {
        'src/foo.test.ts': `test('a', () => {})\n`,
        'src/foo.ts': `export const x = 1\n`,
      },
    )
    expect(
      result.violations.filter((v) => v.ruleId === 'test-file-deleted'),
    ).toEqual([])
    expect(code).toBe(0)
  })

  it('FIXTURE e2e deleted with nested src basename companion passes', () => {
    const { code, result } = cliRatchet(
      {
        'e2e/filmstrip.spec.ts': null,
        'src/editor/Filmstrip.tsx': null,
      },
      {
        'e2e/filmstrip.spec.ts': `test('a', async () => {})\n`,
        'src/editor/Filmstrip.tsx': `export const Filmstrip = () => null\n`,
      },
    )
    expect(
      result.violations.filter((v) => v.ruleId === 'test-file-deleted'),
    ).toEqual([])
    expect(code).toBe(0)
  })

  it('CLI --pr-body empty overrides PR_POLICY_BODY env', () => {
    const prev = process.env.PR_POLICY_BODY
    process.env.PR_POLICY_BODY =
      'Owner-approved scope change: https://example.com'
    try {
      const item = 'docs/roadmap/M2.1/demo-slug.md'
      const base = `# demo\nStatus: open\n- **Done when:** hard\n`
      const root = tmpDir()
      const baseTree = baseFiles({ [item]: base })
      const headTree = baseFiles({
        [item]: `# demo\nStatus: open\n- **Done when:** soft\n`,
      })
      writeTree(path.join(root, 'base'), baseTree)
      writeTree(path.join(root, 'head'), headTree)
      const code = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
        '--pr-body',
        '',
      ])
      expect(code).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.PR_POLICY_BODY
      else process.env.PR_POLICY_BODY = prev
    }
  })

  it('CLI --pr-body-env reads named env and skips when unset', () => {
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- **Done when:** hard\n`
    const soft = `# demo\nStatus: open\n- **Done when:** soft\n`
    const root = tmpDir()
    const baseTree = baseFiles({ [item]: base })
    const headTree = baseFiles({ [item]: soft })
    writeTree(path.join(root, 'base'), baseTree)
    writeTree(path.join(root, 'head'), headTree)
    const envName = 'GATE_RATCHET_TEST_PR_BODY'
    const prev = process.env[envName]
    const prevPolicy = process.env.PR_POLICY_BODY
    delete process.env.PR_POLICY_BODY
    try {
      process.env[envName] =
        'Owner-approved scope change: https://example.com/from-env'
      const ok = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
        '--pr-body-env',
        envName,
      ])
      expect(ok).toBe(0)

      delete process.env[envName]
      const missing = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
        '--pr-body-env',
        envName,
      ])
      expect(missing).toBe(1)

      process.env[envName] = ''
      const emptyEnv = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
        '--pr-body-env',
        envName,
      ])
      expect(emptyEnv).toBe(1)
    } finally {
      if (prev === undefined) delete process.env[envName]
      else process.env[envName] = prev
      if (prevPolicy === undefined) delete process.env.PR_POLICY_BODY
      else process.env.PR_POLICY_BODY = prevPolicy
    }
  })

  it('CLI PR_POLICY_BODY env applies when no --pr-body flags', () => {
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- **Done when:** hard\n`
    const root = tmpDir()
    writeTree(path.join(root, 'base'), baseFiles({ [item]: base }))
    writeTree(
      path.join(root, 'head'),
      baseFiles({
        [item]: `# demo\nStatus: open\n- **Done when:** soft\n`,
      }),
    )
    const prev = process.env.PR_POLICY_BODY
    const prevBranch = process.env.PR_POLICY_BRANCH
    const prevGh = process.env.GITHUB_HEAD_REF
    try {
      process.env.PR_POLICY_BODY =
        'Owner-approved scope change: https://example.com/policy'
      delete process.env.PR_POLICY_BRANCH
      delete process.env.GITHUB_HEAD_REF
      const code = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
      ])
      expect(code).toBe(0)

      delete process.env.PR_POLICY_BODY
      // unset: should fail without approval
      const unset = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
      ])
      expect(unset).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.PR_POLICY_BODY
      else process.env.PR_POLICY_BODY = prev
      if (prevBranch === undefined) delete process.env.PR_POLICY_BRANCH
      else process.env.PR_POLICY_BRANCH = prevBranch
      if (prevGh === undefined) delete process.env.GITHUB_HEAD_REF
      else process.env.GITHUB_HEAD_REF = prevGh
    }
  })

  it('CLI branch falls back to PR_POLICY_BRANCH then GITHUB_HEAD_REF', () => {
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- **Done when:** hard\n`
    const soft = `# demo\nStatus: open\n- **Done when:** soft\n`
    const root = tmpDir()
    writeTree(path.join(root, 'base'), baseFiles({ [item]: base }))
    writeTree(path.join(root, 'head'), baseFiles({ [item]: soft }))
    const prevBranch = process.env.PR_POLICY_BRANCH
    const prevGh = process.env.GITHUB_HEAD_REF
    const prevBody = process.env.PR_POLICY_BODY
    try {
      delete process.env.PR_POLICY_BODY
      delete process.env.GITHUB_HEAD_REF
      process.env.PR_POLICY_BRANCH = 'feat/demo-slug'
      expect(
        runGateRatchetCli([
          '--cwd',
          root,
          '--base-dir',
          'base',
          '--head-dir',
          'head',
        ]),
      ).toBe(1)

      delete process.env.PR_POLICY_BRANCH
      process.env.GITHUB_HEAD_REF = 'feat/demo-slug'
      expect(
        runGateRatchetCli([
          '--cwd',
          root,
          '--base-dir',
          'base',
          '--head-dir',
          'head',
        ]),
      ).toBe(1)
    } finally {
      if (prevBranch === undefined) delete process.env.PR_POLICY_BRANCH
      else process.env.PR_POLICY_BRANCH = prevBranch
      if (prevGh === undefined) delete process.env.GITHUB_HEAD_REF
      else process.env.GITHUB_HEAD_REF = prevGh
      if (prevBody === undefined) delete process.env.PR_POLICY_BODY
      else process.env.PR_POLICY_BODY = prevBody
    }
  })

  it('CLI --pr-body-env is ignored when --pr-body is present', () => {
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- **Done when:** hard\n`
    const root = tmpDir()
    writeTree(path.join(root, 'base'), baseFiles({ [item]: base }))
    writeTree(
      path.join(root, 'head'),
      baseFiles({
        [item]: `# demo\nStatus: open\n- **Done when:** soft\n`,
      }),
    )
    const envName = 'GATE_RATCHET_TEST_PR_BODY2'
    const prev = process.env[envName]
    try {
      process.env[envName] =
        'Owner-approved scope change: https://example.com/should-not-win'
      const code = runGateRatchetCli([
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
        '--branch',
        'feat/demo-slug',
        '--pr-body',
        '',
        '--pr-body-env',
        envName,
      ])
      expect(code).toBe(1)
    } finally {
      if (prev === undefined) delete process.env[envName]
      else process.env[envName] = prev
    }
  })

  it('FIXTURE done-when-rewrite fails', () => {
    expect(FIXTURE_IDS).toContain('done-when-rewrite')
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- **Done when:** hard\n`
    const { code, result } = cliRatchet(
      { [item]: `# demo\nStatus: open\n- **Done when:** soft\n` },
      { [item]: base },
      { branch: 'feat/demo-slug', prBody: '' },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'item-criteria-loosened'),
    ).toBe(true)
  })

  it('FIXTURE deferral-item fails', () => {
    expect(FIXTURE_IDS).toContain('deferral-item')
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- [ ] A\n`
    const { code, result } = cliRatchet(
      {
        [item]: base,
        'docs/roadmap/M2.1/demo-slug-later.md':
          'follow-up to defer mutation for demo-slug\n',
      },
      { [item]: base },
      { branch: 'feat/demo-slug', prBody: '' },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'item-criteria-loosened'),
    ).toBe(true)
  })

  it('FIXTURE checkbox-done-note passes', () => {
    expect(FIXTURE_IDS).toContain('checkbox-done-note')
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- [ ] A\n`
    const head = `# demo\nStatus: done\n- [x] A\n\n## Done note\nShipped.\n`
    const { code, result } = cliRatchet(
      { [item]: head },
      { [item]: base },
      { branch: 'feat/demo-slug', prBody: '' },
    )
    expect(
      result.violations.filter((v) => v.ruleId === 'item-criteria-loosened'),
    ).toEqual([])
    expect(code).toBe(0)
  })

  it('FIXTURE done-when-heading-bypass fails pr-policy', () => {
    expect(FIXTURE_IDS).toContain('done-when-heading-bypass')
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- [ ] A\n`
    const head = `${base}\n## Done when (revised)\n\nOnly lint passes; mutation bar deferred.\n`
    const { code, result } = cliRatchet(
      { [item]: head },
      { [item]: base },
      { branch: 'feat/demo-slug', prBody: '' },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'item-criteria-loosened'),
    ).toBe(true)
  })

  it('FIXTURE blank-done-when-bypass fails pr-policy', () => {
    expect(FIXTURE_IDS).toContain('blank-done-when-bypass')
    const item = 'docs/roadmap/M2.1/demo-slug.md'
    const base = `# demo\nStatus: open\n- [ ] A\n`
    const head = `${base}\n\n- **Done when:** lint passes only\n`
    const { code, result } = cliRatchet(
      { [item]: head },
      { [item]: base },
      { branch: 'feat/demo-slug', prBody: '' },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'item-criteria-loosened'),
    ).toBe(true)
  })

  it('Gate ratchet workflow run: has no PR-controlled ${{ }} expressions', () => {
    const yml = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/pr-policy.yml'),
      'utf8',
    )
    const stepAt = yml.indexOf('name: Gate ratchet (base script vs head tree)')
    expect(stepAt).toBeGreaterThanOrEqual(0)
    const after = yml.slice(stepAt)
    const runAt = after.indexOf('\n        run:')
    expect(runAt).toBeGreaterThanOrEqual(0)
    const nextStep = after.slice(runAt + 1).search(/\n      - name:/)
    const runBlock =
      nextStep === -1
        ? after.slice(runAt)
        : after.slice(runAt, runAt + 1 + nextStep)
    expect(runBlock).not.toMatch(/\$\{\{\s*github\.head_ref/)
    expect(runBlock).not.toMatch(/\$\{\{\s*github\.event\.pull_request\./)
    expect(runBlock).toContain('--base-ref "$PR_POLICY_BASE_SHA"')
    expect(runBlock).not.toContain('--branch')
  })

  it('comment-only exit 1 does not satisfy failOnNeeds', () => {
    const headIntegration = `
jobs:
  e2e-burn-in:
    steps:
      - name: E2E burn-in
        run: pnpm exec playwright test --repeat-each=10
  e2e:
    steps:
      - name: E2E
        run: pnpm test:e2e
  integration:
    needs: [e2e, e2e-burn-in]
    steps:
      - name: Fake aggregate
        run: |
          echo "$BURN_IN_RESULT"
          # exit 1
`
    const { code, result } = cliRatchet({
      '.github/workflows/integration.yml': headIntegration,
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'required-job-step-moved'),
    ).toBe(true)
  })

  it('provider continue-on-error does not satisfy aggregation', () => {
    const headIntegration = `
jobs:
  e2e-burn-in:
    continue-on-error: true
    steps:
      - name: E2E burn-in
        run: pnpm exec playwright test --repeat-each=10
  e2e:
    steps:
      - name: E2E
        run: pnpm test:e2e
  integration:
    needs: [e2e, e2e-burn-in]
    steps:
      - name: Require e2e and burn-in
        run: |
          if [ "$E2E_RESULT" != "success" ]; then exit 1; fi
          if [ "$BURN_IN_RESULT" != "success" ]; then exit 1; fi
`
    const { code, result } = cliRatchet({
      '.github/workflows/integration.yml': headIntegration,
    })
    expect(code).toBe(1)
    expect(
      result.violations.some((v) => v.ruleId === 'required-job-step-moved'),
    ).toBe(true)
  })

  it('identical trees pass via CLI', () => {
    const { code, result } = cliRatchet({})
    expect(code).toBe(0)
    expect(result.ok).toBe(true)
  })
})

describe('numberWeaker / parsePercentish', () => {
  it('higher-stricter and lower-stricter', () => {
    expect(numberWeaker(80, 70, 'higher-stricter')).toBe(true)
    expect(numberWeaker(80, 90, 'higher-stricter')).toBe(false)
    expect(numberWeaker(0, 2, 'lower-stricter')).toBe(true)
    expect(numberWeaker(2, 0, 'lower-stricter')).toBe(false)
    expect(numberWeaker('80', 70, 'higher-stricter')).toBe(false)
    expect(numberWeaker(80, undefined, 'higher-stricter')).toBe(false)
  })

  it('parsePercentish handles number, percent string, auto, junk', () => {
    expect(parsePercentish(85)).toBe(85)
    expect(parsePercentish('85%')).toBe(85)
    expect(parsePercentish('0.5')).toBe(0.5)
    expect(parsePercentish('auto')).toBeNull()
    expect(parsePercentish('nope')).toBeNull()
    expect(parsePercentish(NaN)).toBeNull()
    expect(parsePercentish(null)).toBeNull()
  })
})

describe('extractCoverageIncludes', () => {
  it('finds agent.mjs', () => {
    expect(extractCoverageIncludes(baseVite)).toContain('scripts/agent.mjs')
  })

  it('returns empty when include missing', () => {
    expect(extractCoverageIncludes('export default {}')).toEqual([])
  })

  it('parses real vite.config.ts coverage.include (not test.include)', () => {
    const realVite = fs.readFileSync(
      path.join(REPO_ROOT, 'vite.config.ts'),
      'utf8',
    )
    const includes = extractCoverageIncludes(realVite)
    expect(includes).toEqual(['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'])
    expect(includes).not.toContain('scripts/**/*.test.mjs')
    expect(includes).not.toContain('src/**/*.{test,spec}.{ts,tsx}')
    expect(sliceCoverageConfigBlock(realVite)).toContain("'scripts/**/*.mjs'")

    const headVite = realVite.replace(", 'scripts/**/*.mjs'", '')
    expect(headVite.includes("'scripts/**/*.mjs'")).toBe(false)
    const r = compareGateTrees(
      baseFiles({ 'vite.config.ts': realVite }),
      baseFiles({ 'vite.config.ts': headVite }),
    )
    expect(r.ok).toBe(false)
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'include-removed' &&
          v.message.includes('scripts/**/*.mjs'),
      ),
    ).toBe(true)
  })

  it('skips coverageExcludeGlobs / prefixed idents / non-object coverage', () => {
    for (const ch of ['a', 'z', 'A', 'Z', '0', '9', '_', '$', 'm', '5']) {
      expect(isIdentContinue(ch)).toBe(true)
    }
    for (const ch of ['`', '{', '@', '[', '/', ':', ' ', '\t', '-', '.']) {
      expect(isIdentContinue(ch)).toBe(false)
    }

    expect(
      extractCoverageIncludes(`
export const coverageExcludeGlobs = ['skip-me'] as const
test: { include: ['tests/**'] }
coverage: { include: ['src/**'] }
`),
    ).toEqual(['src/**'])

    expect(
      extractCoverageIncludes(
        'foocoverage: { include: ["no"] }\ncoverage: { include: ["yes"] }',
      ),
    ).toEqual(['yes'])
    expect(
      extractCoverageIncludes(
        '$coverage: { include: ["no"] }\ncoverage: { include: ["yes"] }',
      ),
    ).toEqual(['yes'])
    expect(
      extractCoverageIncludes(
        '_coverage: { include: ["no"] }\ncoverage: { include: ["yes"] }',
      ),
    ).toEqual(['yes'])
    expect(
      extractCoverageIncludes(
        "coverage: true\ncoverage: { include: ['from-object'] }",
      ),
    ).toEqual(['from-object'])
    expect(
      extractCoverageIncludes(
        "coverage: gates.coverage\ncoverage: { include: ['obj'] }",
      ),
    ).toEqual(['obj'])
    expect(
      extractCoverageIncludes("coverage\t:\n  { include: [ 'spaced' ] }"),
    ).toEqual(['spaced'])
    expect(sliceCoverageConfigBlock('coverage: {')).toBe('')
    expect(sliceCoverageConfigBlock('nope')).toBe('')
    expect(
      extractCoverageIncludes(
        `coverage: { include: ['a'], nested: { x: 1 }, exclude: ['e'] }`,
      ),
    ).toEqual(['a'])
    expect(
      extractCoverageIncludes(`coverage: { include: ["keep-}"] }`),
    ).toEqual(['keep-}'])
    expect(
      extractCoverageExcludes(`
coverage: {
  include: ['src'],
  exclude: ['only-cov-exclude'],
}
`),
    ).toContain('only-cov-exclude')
  })
})

describe('extractCoverageExcludes / extractStrykerGateBits', () => {
  it('reads exclude globs and bang mutate patterns', () => {
    expect(extractCoverageExcludes(baseVite)).toContain('src/**/*.d.ts')
    const bits = extractStrykerGateBits(baseStryker)
    expect(bits.mutate).toContain('src/**/*.ts')
    expect(bits.bang).toContain('!src/**/*.test.ts')
    expect(bits.weakerFlags).toEqual([])
  })

  it('flags weaker stryker options', () => {
    const bits = extractStrykerGateBits(`
      mutate: ['src/**/*.ts']
      mutator: { excludedMutations: ['Boolean'] }
      disableTypeChecks: true
      ignoreStatic: false
      coverageAnalysis: 'off'
      ignorers: [() => {}]
    `)
    expect(bits.excludedMutations).toContain('Boolean')
    expect(bits.weakerFlags).toEqual(
      expect.arrayContaining([
        'disableTypeChecks',
        'ignoreStatic:false',
        'coverageAnalysis:off',
        'ignorers',
      ]),
    )
  })
})

describe('stripShellComments / parseArgs / analyzeWorkflowJobs', () => {
  it('strips hash comments so comment exit 1 is ignored', () => {
    expect(stripShellComments('echo ok\n# exit 1\n')).not.toMatch(/exit 1/)
    expect(stripShellComments('exit 1')).toMatch(/exit 1/)
  })

  it('parseArgs reads known flags', () => {
    expect(
      parseArgs(['--base-dir', 'a', '--head-dir', 'b', '--cwd', '/tmp']),
    ).toEqual({ 'base-dir': 'a', 'head-dir': 'b', cwd: '/tmp' })
  })

  it('analyzeWorkflowJobs detects needs fail and continue-on-error', () => {
    const jobs = analyzeWorkflowJobs(
      parseYaml(`
jobs:
  burn:
    continue-on-error: true
    steps:
      - name: E2E burn-in
        run: pnpm exec playwright test --repeat-each=3
  integration:
    needs: [burn]
    steps:
      - run: |
          if [ "$BURN_IN_RESULT" != "success" ]; then exit 1; fi
`),
    )
    expect(jobs.get('burn')?.continueOnErrorKinds.has('burn-in')).toBe(true)
    expect(jobs.get('integration')?.failOnNeeds).toBe(true)
    expect(jobs.get('integration')?.needs).toEqual(['burn'])
  })
})

describe('compareGateTrees additional weakenings', () => {
  it('fails when gate file deleted', () => {
    const head = baseFiles()
    delete head['codecov.yml']
    const r = compareGateTrees(baseFiles(), head)
    expect(r.violations.some((v) => v.ruleId === 'gate-file-gone')).toBe(true)
  })

  it('fails when codecov patch target lowers or threshold rises', () => {
    const headCodecov = `
coverage:
  status:
    patch:
      default:
        target: 50%
        threshold: 0%
flags:
  unit:
    paths:
      - src/
ignore:
  - e2e/**
`
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'codecov.yml': headCodecov }),
      ).violations.some((v) => v.ruleId === 'codecov-weaker'),
    ).toBe(true)

    const higherThreshold = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 5%
flags:
  unit:
    paths:
      - src/
ignore:
  - e2e/**
`
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'codecov.yml': higherThreshold }),
      ).violations.some((v) => /threshold/.test(v.message)),
    ).toBe(true)

    const infoOn = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
        informational: true
flags:
  unit:
    paths:
      - src/
ignore:
  - e2e/**
`
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'codecov.yml': infoOn }),
      ).violations.some((v) => /informational/.test(v.message)),
    ).toBe(true)
  })

  it('fails when codecov ignore grows or flag path removed', () => {
    const headCodecov = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
flags:
  unit:
    paths: []
ignore:
  - e2e/**
  - extra/**
`
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'codecov.yml': headCodecov }),
    )
    expect(r.violations.some((v) => v.ruleId === 'codecov-weaker')).toBe(true)
  })

  it('fails when patchedDependencies grows', () => {
    const headPkg = JSON.stringify({
      name: 't',
      pnpm: {
        patchedDependencies: {
          'a@1': 'patches/a.patch',
          'b@1': 'patches/b.patch',
        },
      },
    })
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'package.json': headPkg }),
    )
    expect(r.violations.some((v) => v.ruleId === 'patched-deps-grown')).toBe(
      true,
    )
  })

  it('fails when playwright retries rise or flakySpecs grow', () => {
    const headGates = {
      ...baseGates,
      playwright: { retries: 2, flakyRetries: 2 },
      e2e: { burnInDefault: 10, flakySpecs: ['e2e/x.spec.ts'] },
    }
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'quality/gates.json': JSON.stringify(headGates) }),
    )
    expect(r.violations.some((v) => v.ruleId === 'gates-json-weaker')).toBe(
      true,
    )
  })

  it('fails when requiredCheckJobs drops a job', () => {
    const headGates = {
      ...baseGates,
      requiredCheckJobs: ['checks'],
    }
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'quality/gates.json': JSON.stringify(headGates) }),
    )
    expect(r.violations.some((v) => v.ruleId === 'gates-json-weaker')).toBe(
      true,
    )
  })

  it('fails when coverage exclude glob is added', () => {
    const headVite = `
export const coverageExcludeGlobs = ['src/**/*.d.ts', 'src/secret.ts'] as const
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/agent.mjs'],
      exclude: [...coverageExcludeGlobs],
    },
  },
}
`
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'vite.config.ts': headVite }),
    )
    expect(r.violations.some((v) => v.ruleId === 'exclude-added')).toBe(true)
  })

  it('fails when lighthouse budget path/type missing or budget rises', () => {
    const headMissingPath = {
      ...baseGates,
      lighthouse: {
        ...baseGates.lighthouse,
        budgets: [{ path: '/other', resourceSizes: [], resourceCounts: [] }],
      },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(headMissingPath) }),
      ).violations.some((v) => /budgets path missing/.test(v.message)),
    ).toBe(true)

    const headMissingType = {
      ...baseGates,
      lighthouse: {
        ...baseGates.lighthouse,
        budgets: [
          {
            path: '/*',
            resourceSizes: [{ resourceType: 'document', budget: 20 }],
            resourceCounts: [],
          },
        ],
      },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(headMissingType) }),
      ).violations.some((v) => /resourceType missing/.test(v.message)),
    ).toBe(true)

    const headHigher = {
      ...baseGates,
      lighthouse: {
        ...baseGates.lighthouse,
        budgets: [
          {
            path: '/*',
            resourceSizes: [{ resourceType: 'script', budget: 999 }],
            resourceCounts: [],
          },
        ],
      },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(headHigher) }),
      ).violations.some((v) => /lighthouse budget script/.test(v.message)),
    ).toBe(true)
  })

  it('fails when requiredCheckJobs removed or lighthouse assertion weakens', () => {
    const noJobs = { ...baseGates }
    delete noJobs.requiredCheckJobs
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(noJobs) }),
      ).violations.some((v) => /requiredCheckJobs removed/.test(v.message)),
    ).toBe(true)

    const softAssert = {
      ...baseGates,
      lighthouse: {
        ...baseGates.lighthouse,
        assertions: { 'performance-budget': 'warn' },
      },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(softAssert) }),
      ).violations.some((v) => /no longer error/.test(v.message)),
    ).toBe(true)

    const dropAssert = {
      ...baseGates,
      lighthouse: { ...baseGates.lighthouse, assertions: {} },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(dropAssert) }),
      ).violations.some((v) => /assertions missing/.test(v.message)),
    ).toBe(true)
  })

  it('fails when burnInDefault or stryker thresholds drop', () => {
    const burn = {
      ...baseGates,
      e2e: { ...baseGates.e2e, burnInDefault: 1 },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(burn) }),
      ).violations.some((v) => /burnInDefault/.test(v.message)),
    ).toBe(true)
    const thr = {
      ...baseGates,
      stryker: { thresholds: { high: 10, low: 5, break: 5 } },
    }
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': JSON.stringify(thr) }),
      ).violations.some((v) => /stryker.thresholds/.test(v.message)),
    ).toBe(true)
  })

  it('fails on codecov component removal, status removal, informational', () => {
    const withComp = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
bundle_analysis:
  status: error
component_management:
  individual_components:
    - component_id: core
      paths: [src/core/**]
flags:
  unit:
    paths: [src/]
ignore: []
`
    const dropComp = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
bundle_analysis:
  status: informational
component_management:
  individual_components: []
flags:
  unit:
    paths: [src/]
ignore: []
`
    const r = compareGateTrees(
      baseFiles({ 'codecov.yml': withComp }),
      baseFiles({ 'codecov.yml': dropComp }),
    )
    expect(r.violations.some((v) => v.ruleId === 'codecov-weaker')).toBe(true)

    const dropStatus = `
coverage:
  status: {}
flags:
  unit:
    paths: [src/]
ignore: []
`
    expect(
      compareGateTrees(
        baseFiles({ 'codecov.yml': withComp }),
        baseFiles({ 'codecov.yml': dropStatus }),
      ).violations.some((v) => /status/.test(v.message)),
    ).toBe(true)
  })

  it('fails when gates.json or codecov.yml is invalid JSON/YAML', () => {
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'quality/gates.json': '{not-json' }),
      ).violations.some((v) =>
        /failed to parse quality\/gates/.test(v.message),
      ),
    ).toBe(true)
    expect(
      compareGateTrees(
        baseFiles(),
        baseFiles({ 'codecov.yml': ':\n  - bad' }),
      ).violations.some((v) => v.ruleId === 'codecov-weaker'),
    ).toBe(true)
  })

  it('fails when quality/gates.json alone is deleted', () => {
    const head = baseFiles()
    delete head['quality/gates.json']
    expect(
      compareGateTrees(baseFiles(), head).violations.some((v) =>
        /quality\/gates\.json deleted/.test(v.message),
      ),
    ).toBe(true)
  })
})

describe('gate-ratchet-cli entry', () => {
  it('runs via node on fixture dirs', () => {
    const root = tmpDir()
    writeTree(path.join(root, 'base'), baseFiles())
    writeTree(
      path.join(root, 'head'),
      baseFiles({
        'quality/gates.json': JSON.stringify({
          ...baseGates,
          coverage: { ...baseGates.coverage, lines: 1 },
        }),
      }),
    )
    const r = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'packages/ts-agent-rig/src/gate-ratchet-cli.mjs'),
        '--cwd',
        root,
        '--base-dir',
        'base',
        '--head-dir',
        'head',
      ],
      { encoding: 'utf8', env: stripGitKeys({ ...process.env }) },
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Gate ratchet: FAIL/)
  })
})

describe('runGateRatchetCli argv', () => {
  it('returns 2 when refs/dirs missing', () => {
    expect(runGateRatchetCli([])).toBe(2)
  })
})

describe('readTreeFromDir / readTreeFromGitRef / pr-policy', () => {
  it('readTreeFromDir skips node_modules and reads files', () => {
    const root = tmpDir()
    fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules/x/a.js'), 'nope')
    fs.writeFileSync(path.join(root, 'ok.txt'), 'yes')
    const files = readTreeFromDir(root)
    expect(files['ok.txt']).toBe('yes')
    expect(files['node_modules/x/a.js']).toBeUndefined()
  })

  it('readTreeFromGitRef reads blobs from a tmp repo', () => {
    const repo = initTmpRepo(tmpDirs, {
      prefix: 'ratchet-git-',
      seedFiles: { 'hello.txt': 'hi\n', 'quality/gates.json': '{}\n' },
    })
    const head = String(gitExec(['rev-parse', 'HEAD'], repo)).trim()
    const files = readTreeFromGitRef(repo, head)
    expect(files['hello.txt']).toBe('hi\n')
    expect(files['quality/gates.json']).toBe('{}\n')
  })

  it('readTreeFromGitRef throws when ls-tree fails', () => {
    const repo = initTmpRepo(tmpDirs, { prefix: 'ratchet-bad-' })
    expect(() => readTreeFromGitRef(repo, 'missing-ref-zzz')).toThrow(
      /ls-tree failed/,
    )
  })

  it('resolvePrPolicyBaseRef prefers GATE_RATCHET_BASE then origin/main then main', () => {
    expect(
      resolvePrPolicyBaseRef({
        root: '/tmp',
        env: { GATE_RATCHET_BASE: ' abc ' },
        git: () => ({ status: 1, stdout: '', stderr: '' }),
      }),
    ).toBe('abc')
    const calls = []
    expect(
      resolvePrPolicyBaseRef({
        root: '/tmp',
        env: {},
        git: (args) => {
          calls.push(args.join(' '))
          if (args.includes('origin/main')) {
            return { status: 0, stdout: 'originsha\n', stderr: '' }
          }
          return { status: 1, stdout: '', stderr: '' }
        },
      }),
    ).toBe('originsha')
    expect(calls[0]).toContain('origin/main')
    expect(
      resolvePrPolicyBaseRef({
        root: '/tmp',
        env: {},
        git: (args) => {
          if (args.includes('origin/main')) {
            return { status: 1, stdout: '', stderr: '' }
          }
          return { status: 0, stdout: 'mainsha\n', stderr: '' }
        },
      }),
    ).toBe('mainsha')
    expect(
      resolvePrPolicyBaseRef({
        root: '/tmp',
        env: {},
        git: () => ({ status: 1, stdout: '', stderr: '' }),
      }),
    ).toBeNull()
  })

  it('runPrPolicyCheck skips, fails HEAD, or delegates to CLI', () => {
    const logs = []
    expect(
      runPrPolicyCheck({
        root: '/tmp',
        env: {},
        git: () => ({ status: 1, stdout: '', stderr: '' }),
        log: (m) => logs.push(m),
      }),
    ).toBe(0)
    expect(logs.join('\n')).toMatch(/skip/)

    const errs = []
    expect(
      runPrPolicyCheck({
        root: '/tmp',
        env: { GATE_RATCHET_BASE: 'base' },
        git: (args) => {
          if (args.includes('HEAD')) {
            return { status: 1, stdout: '', stderr: 'no head' }
          }
          return { status: 0, stdout: 'ok\n', stderr: '' }
        },
        error: (m) => errs.push(m),
      }),
    ).toBe(1)
    expect(errs.join('\n')).toMatch(/cannot resolve HEAD/)

    let seen
    expect(
      runPrPolicyCheck({
        root: '/repo',
        env: { GATE_RATCHET_BASE: 'basesha' },
        git: () => ({ status: 0, stdout: 'headsha\n', stderr: '' }),
        runCli: (argv) => {
          seen = argv
          return 0
        },
      }),
    ).toBe(0)
    expect(seen).toEqual([
      '--cwd',
      '/repo',
      '--base-ref',
      'basesha',
      '--head-ref',
      'headsha',
    ])
  })

  it('runPrPolicyCheck against twin commits in a tmp repo', () => {
    const repo = initTmpRepo(tmpDirs, {
      prefix: 'pr-policy-',
      seedFiles: baseFiles(),
    })
    const base = String(gitExec(['rev-parse', 'HEAD'], repo)).trim()
    fs.writeFileSync(
      path.join(repo, 'quality/gates.json'),
      JSON.stringify({
        ...baseGates,
        coverage: { ...baseGates.coverage, lines: 10 },
      }),
    )
    gitExec(['add', '.'], repo, { stdio: 'ignore' })
    gitExec(['commit', '-m', 'weaker'], repo, { stdio: 'ignore' })
    const code = runPrPolicyCheck({
      root: repo,
      env: { GATE_RATCHET_BASE: base },
    })
    expect(code).toBe(1)
  })
})

describe('compareGatesJson / compareCodecov exact messages', () => {
  it('emits exact weaker messages for every numeric gate path', () => {
    const msgs = []
    const fail = (m) => msgs.push(m)
    const weaker = {
      coverage: { statements: 1, branches: 1, functions: 1, lines: 1 },
      stryker: {
        thresholds: { high: 1, low: 1, break: 1 },
        diffThresholds: { high: 1, low: 1, break: 1 },
      },
      lighthouse: {
        numberOfRuns: 0,
        assertions: {},
        budgets: [],
      },
      playwright: { retries: 9, flakyRetries: 9 },
      e2e: { burnInDefault: 1, flakySpecs: ['x.spec.ts'] },
      requiredCheckJobs: [],
    }
    compareGatesJson(baseGates, weaker, 'quality/gates.json', fail)
    expect(msgs).toContain(
      'quality/gates.json coverage.statements: 80 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json coverage.branches: 80 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json coverage.functions: 80 → 1 (weaker)',
    )
    expect(msgs).toContain('quality/gates.json coverage.lines: 80 → 1 (weaker)')
    expect(msgs).toContain(
      'quality/gates.json stryker.thresholds.high: 80 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json stryker.thresholds.low: 60 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json stryker.thresholds.break: 60 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json stryker.diffThresholds.high: 90 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json stryker.diffThresholds.low: 85 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json stryker.diffThresholds.break: 85 → 1 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json lighthouse.numberOfRuns: 1 → 0 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json playwright.retries: 0 → 9 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json playwright.flakyRetries: 2 → 9 (weaker)',
    )
    expect(msgs).toContain(
      'quality/gates.json e2e.burnInDefault: 10 → 1 (weaker)',
    )
    expect(msgs).toContain('quality/gates.json e2e.flakySpecs grew: x.spec.ts')
    expect(msgs).toContain(
      'quality/gates.json requiredCheckJobs missing checks',
    )
    expect(msgs).toContain(
      'quality/gates.json lighthouse.assertions missing performance-budget',
    )
  })

  it('passes when all numeric values are equal or stricter', () => {
    const msgs = []
    compareGatesJson(baseGates, baseGates, 'quality/gates.json', (m) =>
      msgs.push(m),
    )
    expect(msgs).toEqual([])
    const stricter = {
      ...baseGates,
      coverage: { statements: 90, branches: 90, functions: 90, lines: 90 },
      playwright: { retries: 0, flakyRetries: 0 },
    }
    compareGatesJson(baseGates, stricter, 'quality/gates.json', (m) =>
      msgs.push(m),
    )
    expect(msgs).toEqual([])
  })

  it('emits exact codecov messages for target/threshold/flag/ignore/component', () => {
    const msgs = []
    const base = {
      coverage: {
        status: {
          patch: { default: { target: '85%', threshold: '0%' } },
          project: {
            default: { target: 'auto', threshold: '1%', informational: false },
          },
        },
      },
      bundle_analysis: { status: 'error' },
      flags: { unit: { paths: ['src/', 'scripts/'] } },
      ignore: ['e2e/**'],
      component_management: {
        individual_components: [{ component_id: 'core', paths: ['src/core'] }],
      },
    }
    const head = {
      coverage: {
        status: {
          patch: {
            default: {
              target: '50%',
              threshold: '5%',
              informational: true,
            },
          },
        },
      },
      bundle_analysis: { status: 'informational' },
      flags: { unit: { paths: ['src/'] } },
      ignore: ['e2e/**', 'tmp/**'],
      component_management: { individual_components: [] },
    }
    compareCodecov(base, head, (m) => msgs.push(m))
    expect(msgs).toContain(
      'codecov.yml coverage.status.patch.default.target: 85% → 50%',
    )
    expect(msgs).toContain(
      'codecov.yml coverage.status.patch.default.threshold: 0% → 5%',
    )
    expect(msgs).toContain(
      'codecov.yml coverage.status.patch.default informational turned on',
    )
    expect(msgs).toContain('codecov.yml coverage.status.project removed')
    expect(msgs).toContain(
      'codecov.yml bundle_analysis informational turned on',
    )
    expect(msgs).toContain('codecov.yml flags.unit.paths removed scripts/')
    expect(msgs).toContain('codecov.yml ignore added tmp/**')
    expect(msgs).toContain('codecov.yml component core removed')
  })

  it('fails when codecov flag or component_management is removed', () => {
    const msgs = []
    compareCodecov(
      {
        flags: { unit: { paths: ['src/'] } },
        component_management: {
          individual_components: [{ component_id: 'core' }],
        },
      },
      { flags: {} },
      (m) => msgs.push(m),
    )
    expect(msgs).toContain('codecov.yml flags.unit removed')
    expect(msgs).toContain(
      'codecov.yml component_management.individual_components removed',
    )
  })
})

describe('classifyGateSteps / analyzeWorkflowJobs extra branches', () => {
  it('classifies uses: actions and burn-in-targets run', () => {
    expect(
      classifyGateSteps({
        name: 'Secrets',
        uses: 'gitleaks/gitleaks-action@v2',
      }).has('gitleaks'),
    ).toBe(true)
    expect(
      classifyGateSteps({
        run: 'node scripts/burn-in-targets.mjs',
      }).has('burn-in'),
    ).toBe(true)
    expect(
      classifyGateSteps({
        run: 'pnpm exec playwright test',
      }).has('e2e'),
    ).toBe(true)
    expect(
      classifyGateSteps({
        run: 'vitest run --coverage',
      }).has('coverage'),
    ).toBe(true)
  })

  it('detects needs.*.result exit 1 and step continue-on-error', () => {
    const jobs = analyzeWorkflowJobs(
      parseYaml(`
jobs:
  unit:
    steps:
      - name: Coverage
        continue-on-error: true
        run: pnpm test:coverage
  gate:
    needs: unit
    steps:
      - run: |
          if [ "\${{ needs.unit.result }}" != "success" ]; then exit 1; fi
`),
    )
    expect(jobs.get('unit')?.continueOnErrorKinds.has('coverage')).toBe(true)
    expect(jobs.get('gate')?.failOnNeeds).toBe(true)
    expect(jobs.get('gate')?.needs).toEqual(['unit'])
  })

  it('string needs becomes a one-element array', () => {
    const jobs = analyzeWorkflowJobs(
      parseYaml(`
jobs:
  a:
    steps:
      - run: pnpm test:e2e
  b:
    needs: a
    steps:
      - run: echo ok
`),
    )
    expect(jobs.get('b')?.needs).toEqual(['a'])
  })
})

describe('extractCoverage / stryker / parseArgs edge cases', () => {
  it('reads inline exclude without coverageExcludeGlobs export', () => {
    const vite = `
export default {
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/skip.ts'],
    },
  },
}
`
    expect(extractCoverageExcludes(vite)).toEqual(['src/skip.ts'])
    expect(extractCoverageIncludes(vite)).toEqual(['src/**/*.ts'])
  })

  it('does not flag empty ignorers array as weaker', () => {
    const bits = extractStrykerGateBits(`
      mutate: ['src/**/*.ts']
      ignorers: []
      coverageAnalysis: 'perTest'
      ignoreStatic: true
    `)
    expect(bits.weakerFlags).not.toContain('ignorers')
  })

  it('parseArgs leaves empty string when flag value is missing', () => {
    expect(parseArgs(['--base-dir'])).toEqual({ 'base-dir': '' })
  })

  it('parseExportedStringArray returns [] for missing export', () => {
    expect(parseExportedStringArray('export const X = 1', 'RULE_IDS')).toEqual(
      [],
    )
  })

  it('stripShellComments handles nullish and windows newlines', () => {
    expect(stripShellComments(null)).toBe('')
    expect(stripShellComments('a\r\n#b\r\nc')).toBe('a\n\nc')
  })
})

describe('compareGateTrees remaining weakenings', () => {
  it('emits exact ruleId+message for lighthouse numberOfRuns drop', () => {
    const headGates = {
      ...baseGates,
      lighthouse: { ...baseGates.lighthouse, numberOfRuns: 0 },
    }
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'quality/gates.json': JSON.stringify(headGates) }),
    )
    expect(r.violations).toContainEqual({
      ruleId: 'gates-json-weaker',
      message: 'quality/gates.json lighthouse.numberOfRuns: 1 → 0 (weaker)',
    })
  })

  it('detects istanbul ignore and eslint-disable additions', () => {
    const r = compareGateTrees(
      baseFiles({ 'src/x.ts': 'export const a = 1\n' }),
      baseFiles({
        'src/x.ts':
          '/* istanbul ignore next */\neslint-disable no-var\nexport const a = 1\n',
      }),
    )
    // eslint-disable without -next-line is matched; istanbul ignore too.
    expect(r.violations.some((v) => v.ruleId === 'ignore-comment-added')).toBe(
      true,
    )
  })

  it('does not flag Stryker disable inside the detector file itself', () => {
    const r = compareGateTrees(
      baseFiles({
        'scripts/check-gate-ratchet.mjs': scriptWithIds(),
      }),
      baseFiles({
        'scripts/check-gate-ratchet.mjs':
          '// Stryker disable all\n' + scriptWithIds(),
      }),
    )
    expect(r.violations.some((v) => v.ruleId === 'stryker-disable-added')).toBe(
      false,
    )
  })

  it('does flag Stryker disable in check-codecov-yml.mjs', () => {
    const r = compareGateTrees(
      baseFiles({
        'scripts/check-codecov-yml.mjs': 'export const x = 1\n',
      }),
      baseFiles({
        'scripts/check-codecov-yml.mjs':
          '// Stryker disable BooleanLiteral\nexport const x = 1\n',
      }),
    )
    expect(r.violations).toContainEqual({
      ruleId: 'stryker-disable-added',
      message:
        'mutation suppression comment added in scripts/check-codecov-yml.mjs',
    })
  })

  it('case and whitespace variants of Stryker disable still fail', () => {
    const variants = [
      '// stryker disable all\nexport const x = 1\n',
      '// STRYKER  DISABLE all\nexport const x = 1\n',
      '//\tStryker\tdisable\tall\nexport const x = 1\n',
      '// Stryker restore all\nexport const x = 1\n',
    ]
    for (const head of variants) {
      const r = compareGateTrees(
        baseFiles({ 'src/app.ts': 'export const x = 1\n' }),
        baseFiles({ 'src/app.ts': head }),
      )
      expect(
        r.violations.some((v) => v.ruleId === 'stryker-disable-added'),
      ).toBe(true)
    }
  })

  it('block, trailing, and mid-line Stryker disables fail pr-policy', () => {
    const probes = [
      '/* Stryker disable all */\nexport const x = 1\n',
      'const x = 1 // Stryker disable all\n',
      '  /* Stryker disable next-line all */ foo()\n',
    ]
    for (const head of probes) {
      expect(countStrykerDisable(head)).toBeGreaterThanOrEqual(
        countStrykerDisableMainStyle(head),
      )
      expect(countStrykerDisable(head)).toBeGreaterThan(0)
      expect(
        collectStrykerDisableComments(head).illegal.length,
      ).toBeGreaterThan(0)
      const r = compareGateTrees(
        baseFiles({ 'src/app.ts': 'export const x = 1\n' }),
        baseFiles({ 'src/app.ts': head }),
      )
      expect(
        r.violations.some((v) => v.ruleId === 'stryker-disable-added'),
      ).toBe(true)
    }
  })

  it('head countStrykerDisable never under-counts main-style', () => {
    const samples = [
      '',
      'export const x = 1\n',
      '// Stryker disable all\n',
      '/* Stryker disable all */\n',
      'const x = 1 // Stryker disable all\n',
      'Strykerdisable\n',
      'stryker disable all\n',
      'STRYKER  DISABLE all\n',
      '// Stryker restore all\n',
      LEGAL_DISABLE,
      '### Mutation suppressions\n',
      'collectStrykerDisableComments(text)\n',
    ]
    for (const sample of samples) {
      expect(countStrykerDisable(sample)).toBeGreaterThanOrEqual(
        countStrykerDisableMainStyle(sample),
      )
    }
  })

  it('raised mutation.disableBudget fails gates-json-weaker', () => {
    const r = compareGateTrees(
      baseFiles({ 'quality/gates.json': gatesWithBudget(0) }),
      baseFiles({ 'quality/gates.json': gatesWithBudget(1) }),
    )
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'gates-json-weaker' &&
          /mutation\.disableBudget/.test(v.message),
      ),
    ).toBe(true)
  })

  it('weaker diffThresholds fails gates-json-weaker', () => {
    const head = {
      ...baseGates,
      stryker: {
        ...baseGates.stryker,
        diffThresholds: { high: 90, low: 85, break: 80 },
      },
    }
    const r = compareGateTrees(
      baseFiles({ 'quality/gates.json': JSON.stringify(baseGates) }),
      baseFiles({ 'quality/gates.json': JSON.stringify(head) }),
    )
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'gates-json-weaker' &&
          /stryker\.diffThresholds\.break/.test(v.message),
      ),
    ).toBe(true)
  })

  it('diffThresholds below nightly fails diff-below-nightly', () => {
    const head = {
      ...baseGates,
      stryker: {
        thresholds: { high: 80, low: 60, break: 60 },
        diffThresholds: { high: 90, low: 85, break: 50 },
      },
    }
    const r = compareGateTrees(
      baseFiles({ 'quality/gates.json': JSON.stringify(baseGates) }),
      baseFiles({ 'quality/gates.json': JSON.stringify(head) }),
    )
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'diff-below-nightly' &&
          /diffThresholds\.break/.test(v.message),
      ),
    ).toBe(true)
    const msgs = []
    compareDiffVsNightly(head, 'quality/gates.json', (m) => msgs.push(m))
    expect(msgs.some((m) => m.includes('50 < 60'))).toBe(true)
  })

  it('diffThresholds equal to nightly does not fail', () => {
    const head = {
      stryker: {
        thresholds: { high: 80, low: 60, break: 60 },
        diffThresholds: { high: 80, low: 60, break: 60 },
      },
    }
    const msgs = []
    compareDiffVsNightly(head, 'quality/gates.json', (m) => msgs.push(m))
    expect(msgs).toEqual([])
  })

  it('diffThresholds skips when a side is non-numeric', () => {
    const msgs = []
    compareDiffVsNightly(
      {
        stryker: {
          thresholds: { high: 80, low: 60, break: 60 },
          diffThresholds: { high: 'x', low: 85, break: 85 },
        },
      },
      'quality/gates.json',
      (m) => msgs.push(m),
    )
    expect(msgs.some((m) => m.includes('diffThresholds.high'))).toBe(false)
  })

  it('temporaryExcludes seed when base has no array passes', () => {
    const base = { ...baseGates, mutation: { disableBudget: 0 } }
    const head = {
      ...baseGates,
      mutation: {
        disableBudget: 0,
        temporaryExcludes: [
          {
            path: 'src/editor/projectSession.ts',
            until: 'project-session-mutation',
          },
        ],
      },
    }
    const r = compareGateTrees(
      baseFiles({ 'quality/gates.json': JSON.stringify(base) }),
      baseFiles({ 'quality/gates.json': JSON.stringify(head) }),
    )
    expect(
      r.violations.some((v) => v.ruleId === 'temporary-excludes-grew'),
    ).toBe(false)
  })

  it('grown temporaryExcludes fails temporary-excludes-grew', () => {
    const head = {
      ...baseGates,
      mutation: {
        disableBudget: 0,
        temporaryExcludes: [
          ...baseGates.mutation.temporaryExcludes,
          { path: 'src/new/Excluded.ts', until: 'never' },
        ],
      },
    }
    const r = compareGateTrees(
      baseFiles({ 'quality/gates.json': JSON.stringify(baseGates) }),
      baseFiles({ 'quality/gates.json': JSON.stringify(head) }),
    )
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'temporary-excludes-grew' &&
          /src\/new\/Excluded\.ts/.test(v.message),
      ),
    ).toBe(true)
    const msgs = []
    compareTemporaryExcludes(baseGates, head, 'quality/gates.json', (m) =>
      msgs.push(m),
    )
    expect(msgs[0]).toContain(MSGS.tempExcludesGrewPrefix)
  })

  it('removed temporaryExcludes array fails temporary-excludes-grew', () => {
    const head = {
      ...baseGates,
      mutation: { disableBudget: 0 },
    }
    const msgs = []
    compareTemporaryExcludes(baseGates, head, 'quality/gates.json', (m) =>
      msgs.push(m),
    )
    expect(msgs).toContain(
      'quality/gates.json mutation.temporaryExcludes removed',
    )
    const r = compareGateTrees(
      baseFiles({ 'quality/gates.json': JSON.stringify(baseGates) }),
      baseFiles({ 'quality/gates.json': JSON.stringify(head) }),
    )
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'temporary-excludes-grew' &&
          /temporaryExcludes removed/.test(v.message),
      ),
    ).toBe(true)
  })

  it('temporaryExcludes ignores non-object rows and keeps equal path set', () => {
    const msgs = []
    compareTemporaryExcludes(
      baseGates,
      {
        ...baseGates,
        mutation: {
          disableBudget: 0,
          temporaryExcludes: [
            null,
            { path: 1 },
            {
              path: 'src/editor/projectSession.ts',
              until: 'project-session-mutation',
            },
          ],
        },
      },
      'quality/gates.json',
      (m) => msgs.push(m),
    )
    expect(msgs).toEqual([])
  })

  it('real src/ and scripts/ have zero Stryker disables', () => {
    /** @type {Record<string, string>} */
    const tree = {}
    for (const root of ['src', 'scripts']) {
      const absRoot = path.join(REPO_ROOT, root)
      /** @param {string} dir */
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            if (ent.name === 'node_modules') continue
            walk(abs)
            continue
          }
          const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/')
          if (!/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(rel)) continue
          if (rel.includes('.test.')) continue
          tree[rel] = fs.readFileSync(abs, 'utf8')
        }
      }
      walk(absRoot)
    }
    expect(Object.keys(tree).length).toBeGreaterThan(10)
    expect(countLegalStrykerDisablesInTree(tree)).toBe(0)
    let illegal = 0
    for (const [p, text] of Object.entries(tree)) {
      if (
        p === 'scripts/check-gate-ratchet.mjs' ||
        p === 'scripts/stryker-disable-detect.mjs'
      ) {
        continue
      }
      illegal += collectStrykerDisableComments(text).illegal.length
    }
    expect(illegal).toBe(0)
  })

  it('flags continue-on-error on a required job gate step', () => {
    const headChecks = `
jobs:
  checks:
    steps:
      - name: Unit and property tests
        continue-on-error: true
        run: pnpm test:coverage
      - name: Dependency audit
        run: pnpm audit:ci
`
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ '.github/workflows/checks.yml': headChecks }),
    )
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'required-job-step-moved' &&
          /continue-on-error/.test(v.message),
      ),
    ).toBe(true)
  })
})

describe('pure helpers exact behaviour', () => {
  it('isRecord accepts only plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(1)).toBe(false)
  })

  it('coerceText / isQuoteChar basics', () => {
    expect(QUOTE_SINGLE).toBe("'")
    expect(QUOTE_DOUBLE).toBe('"')
    expect(isQuoteChar("'")).toBe(true)
    expect(isQuoteChar('"')).toBe(true)
    expect(isQuoteChar('x')).toBe(false)
    expect(coerceText(null)).toBe('')
    expect(coerceText(undefined)).toBe('')
    expect(coerceText('hi')).toBe('hi')
  })

  it('extractQuotedStrings and extractFirstKeyedArray handle = and :', () => {
    expect(extractQuotedStrings(`'a', "b"`)).toEqual(['a', 'b'])
    expect(extractFirstKeyedArray(`mutate = ['!x']`, 'mutate')).toEqual(['!x'])
    expect(extractFirstKeyedArray(`include:['y']`, 'include')).toEqual(['y'])
    expect(
      extractFirstKeyedArray(`mutate\t:\n  [ 'a', "b" ]`, 'mutate'),
    ).toEqual(['a', 'b'])
    expect(extractFirstKeyedArray('mutate: notarray', 'mutate')).toEqual([])
    expect(extractFirstKeyedArray('mutate skip [', 'mutate')).toEqual([])
    expect(extractFirstKeyedArray('nope', 'include')).toEqual([])
    expect(extractCoverageIncludes(null)).toEqual([])
    expect(extractCoverageExcludes(undefined)).toEqual([])
    expect(extractStrykerGateBits(null)).toEqual({
      mutate: [],
      bang: [],
      excludedMutations: [],
      weakerFlags: [],
    })
    expect(
      parseExportedStringArray('export const RULE_IDS = ["a"]', 'RULE_IDS'),
    ).toEqual([])
    expect(
      parseExportedStringArray(
        'export const RULE_IDS = Object.freeze(1)',
        'RULE_IDS',
      ),
    ).toEqual([])
    expect(isWsChar(' ')).toBe(true)
    expect(isWsChar('\t')).toBe(true)
    expect(isWsChar('\n')).toBe(true)
    expect(isWsChar('\r')).toBe(true)
    expect(isWsChar('x')).toBe(false)
  })

  it('compactWs and weaker flag probes are exact', () => {
    expect(compactWs('a \n\tb')).toBe('ab')
    const bits = extractStrykerGateBits(`
      mutate: ["src/**/*.ts"]
      disableTypeChecks: true
      ignoreStatic: false
      coverageAnalysis: "off"
      ignorers: [x]
    `)
    expect(bits.weakerFlags).toEqual([
      'disableTypeChecks',
      'ignoreStatic:false',
      'coverageAnalysis:off',
      'ignorers',
    ])
  })

  it('parsePercentish and dig edge cases', () => {
    expect(parsePercentish('85%')).toBe(85)
    expect(parsePercentish('%')).toBeNull()
    expect(parsePercentish('')).toBeNull()
    expect(parsePercentish('  auto  ')).toBeNull()
    expect(dig({ a: { b: 1 } }, ['a', 'b'])).toBe(1)
    expect(dig({ a: null }, ['a', 'b'])).toBeUndefined()
    expect(dig(null, ['a'])).toBeUndefined()
    expect(dig('x', ['a'])).toBeUndefined()
  })

  it('getFile normalizes slashes and misses unknown keys', () => {
    expect(getFile({ 'a/b': '1' }, 'a\\b')).toBe('1')
    expect(getFile({ 'a/b': '1' }, 'missing')).toBeUndefined()
  })

  it('countIgnoreComments and countStrykerDisable', () => {
    expect(countIgnoreComments('/* v8 ignore next */')).toBe(1)
    expect(countIgnoreComments('/* istanbul ignore next */')).toBe(1)
    expect(countIgnoreComments('/* c8 ignore next */')).toBe(1)
    expect(countIgnoreComments('/* v8  ignore next */')).toBe(1)
    expect(countIgnoreComments('/*\tistanbul\tignore next */')).toBe(1)
    expect(countIgnoreComments('istanbul   ignore else')).toBe(1)
    expect(countIgnoreComments('c8\nignore next')).toBe(1)
    expect(countIgnoreComments('v8ignore next')).toBe(0)
    expect(countIgnoreComments('v8')).toBe(0)
    expect(countIgnoreComments('v8\t\tnot-ignore')).toBe(0)
    expect(countIgnoreComments('eslint-disable no-var')).toBe(1)
    expect(countIgnoreComments('eslint-disable-next-line no-var')).toBe(0)
    expect(countIgnoreComments('@ts-ignore')).toBe(1)
    expect(indexOfToolIgnore('/* v8  ignore */', 'v8', 0)).toBeGreaterThan(-1)
    expect(indexOfToolIgnore('v8ignore', 'v8', 0)).toBe(-1)
    expect(indexOfToolIgnore('v8 notignore', 'v8', 0)).toBe(-1)
    expect(indexOfToolIgnore('v8', 'v8', 0)).toBe(-1)
    expect(indexOfToolIgnore('', 'v8', 0)).toBe(-1)
    expect(indexOfToolIgnore('xx v8  ignore', 'v8', 0)).toBeGreaterThan(-1)
    expect(indexOfToolIgnore('v8  ignore', 'v8', -5)).toBe(0)
    expect(indexOfToolIgnore('v8  ignore v8  ignore', 'v8', 1)).toBeGreaterThan(
      0,
    )
    expect(countStrykerDisable('// Stryker disable all')).toBe(1)
    expect(countStrykerDisable('// Stryker  disable x')).toBe(1)
    expect(countStrykerDisable('Stryker enable')).toBe(0)
    expect(countStrykerDisable(LEGAL_DISABLE)).toBe(1)
    expect(classifyStrykerDisableLine(LEGAL_DISABLE.trim()).kind).toBe('legal')
    expect(classifyStrykerDisableLine('// Stryker disable all').kind).toBe(
      'illegal',
    )
    expect(
      classifyStrykerDisableLine(
        '// Stryker disable next-line BooleanLiteral: short',
      ).kind,
    ).toBe('illegal')
    expect(
      classifyStrykerDisableLine(
        '// Stryker disable next-line BooleanLiteral: 1234567890',
      ).kind,
    ).toBe('legal')
    expect(
      classifyStrykerDisableLine(
        '// Stryker disable next-line BooleanLiteral: 123456789',
      ).kind,
    ).toBe('illegal')
    expect(
      classifyStrykerDisableLine(
        '// Stryker disable next-line : missing mutator here',
      ).kind,
    ).toBe('illegal')
    expect(
      classifyStrykerDisableLine(
        '// Stryker disable next-line BooleanLiteral missing colon reason',
      ).kind,
    ).toBe('illegal')
    expect(classifyStrykerDisableLine('// Stryker restore all').kind).toBe(
      'illegal',
    )
    expect(classifyStrykerDisableLine('export const x = 1')).toBeNull()
    expect(
      classifyStrykerDisableLine('strykerDisablePerFilePrefix: true'),
    ).toBeNull()
    expect(
      countStrykerDisable(
        "  strykerDisablePerFilePrefix: 'stryker disable per-file cap exceeded in ',",
      ),
    ).toBeGreaterThanOrEqual(1)
    expect(
      countStrykerDisable('/* Stryker disable all */'),
    ).toBeGreaterThanOrEqual(
      countStrykerDisableMainStyle('/* Stryker disable all */'),
    )
    expect(
      countStrykerDisable('const x = 1 // Stryker disable all'),
    ).toBeGreaterThanOrEqual(
      countStrykerDisableMainStyle('const x = 1 // Stryker disable all'),
    )
    expect(countStrykerDisableMainStyle('Strykerdisable x')).toBe(1)
    expect(countStrykerDisableMainStyle('stryker disable x')).toBe(0)
    expect(countStrykerDisable('Strykerdisable x')).toBe(1)
    expect(findNextStrykerDirective('Strykerdisable', 0)).toEqual({
      at: 0,
      verb: 'disable',
      verbEnd: 'Strykerdisable'.length,
    })
    expect(findNextStrykerDirective('strykerdisable', 0)).toBeNull()
    expect(findNextStrykerDirective('Strykerfoo', 0)).toBeNull()
    expect(findNextStrykerDirective('nope', 0)).toBeNull()
    expect(findNextStrykerDirective('stryker restore all', 0)).toEqual({
      at: 0,
      verb: 'restore',
      verbEnd: 'stryker restore'.length,
    })
    expect(findNextStrykerDirective('  stryker   disable all', 0)).toEqual({
      at: 2,
      verb: 'disable',
      verbEnd: '  stryker   disable'.length,
    })
    expect(countStrykerDisableMainStyle('Stryker  disable x')).toBe(1)
    expect(countStrykerDisableMainStyle('Stryker\tdisable x')).toBe(1)
    expect(countStrykerDisableMainStyle('Strykerenable')).toBe(0)
    expect(lineContaining('a\nbStryker\nc', 3)).toBe('bStryker')
    expect(matchPrefixIgnoreCase('DISABLE', 0, 'disable')).toBe(7)
    expect(matchPrefixIgnoreCase('xdisable', 0, 'disable')).toBe(-1)
    const legalLine =
      '// Stryker disable next-line BooleanLiteral: justified reason ok'
    expect(
      tryParseLegalNextLineDisable(legalLine, {
        at: legalLine.indexOf('Stryker'),
        verbEnd: legalLine.indexOf('disable') + 'disable'.length,
      }),
    ).toEqual({
      reason: 'justified reason ok',
      mutators: 'BooleanLiteral',
    })
    expect(
      tryParseLegalNextLineDisable('const x = 1 // Stryker disable all', {
        at: 'const x = 1 // '.length,
        verbEnd: 'const x = 1 // Stryker disable'.length,
      }),
    ).toBeNull()
    expect(indexOfIgnoreCase('xx STRYKER yy', 'stryker', 0)).toBe(3)
    expect(indexOfIgnoreCase('abc', 'stryker', 0)).toBe(-1)
    expect(indexOfIgnoreCase('STRYKER', 'stryker', 0)).toBe(0)
    expect(indexOfIgnoreCase('stryker', 'stryker', -3)).toBe(0)
    expect(indexOfIgnoreCase('ab', '', 1)).toBe(1)
    expect(indexOfIgnoreCase('AbcStryker', 'stryker', 0)).toBe(3)
    expect(matchKeywordAt('stryker disable', 0, 'stryker')).toBe(7)
    expect(matchKeywordAt('strykerDisable', 0, 'stryker')).toBe(-1)
    expect(matchKeywordAt('xstryker', 0, 'stryker')).toBe(-1)
    expect(matchKeywordAt('stryker', 0, 'stryker')).toBe(7)
    expect(skipWs('  ab', 0)).toBe(2)
    expect(skipWs('ab', 0)).toBe(0)
    expect(skipWs(' \tab', 0)).toBe(2)
    expect(
      collectStrykerDisableComments(
        '// Stryker disable next-line A,B: long enough reason text\n',
      ).legal[0].mutators,
    ).toBe('A,B')
    expect(
      classifyStrykerDisableLine(
        '//stryker disable next-line X: long enough reason text',
      ).kind,
    ).toBe('legal')
    expect(readDisableBudget({ mutation: { disableBudget: 2 } })).toBe(2)
    expect(readDisableBudget({})).toBe(0)
    expect(readDisableBudget({ mutation: { disableBudget: 'x' } })).toBe(0)
    expect(STRYKER_DISABLE_PER_FILE_CAP).toBe(3)
    expect(STRYKER_DISABLE_REASON_MIN).toBe(10)
    expect(
      countLegalStrykerDisablesInTree({
        'src/a.ts': LEGAL_DISABLE + 'export const x = 1\n',
        'scripts/check-gate-ratchet.mjs': LEGAL_DISABLE + 'export {}\n',
      }),
    ).toBe(1)
    expect(
      countLegalStrykerDisablesInTree({
        'scripts/check-gate-ratchet.mjs': LEGAL_DISABLE + 'export {}\n',
      }),
    ).toBe(0)
    expect(
      classifyStrykerDisableLine(
        '// Stryker disable next-line   BooleanLiteral  : justified reason ok',
      ),
    ).toEqual({
      kind: 'legal',
      reason: 'justified reason ok',
      mutators: 'BooleanLiteral',
    })
    expect(
      classifyStrykerDisableLine(
        'Stryker disable next-line BooleanLiteral: justified reason ok',
      ).kind,
    ).toBe('illegal')
  })

  it('flags ignore-comment-added for spaced v8 ignore on real-shaped trees', () => {
    const r = compareGateTrees(
      baseFiles({ 'src/x.ts': 'export const a = 1\n' }),
      baseFiles({
        'src/x.ts': '/* v8  ignore next */\nexport const a = 1\n',
      }),
    )
    expect(r.violations.some((v) => v.ruleId === 'ignore-comment-added')).toBe(
      true,
    )
    const rTab = compareGateTrees(
      baseFiles({ 'src/y.ts': 'export const b = 1\n' }),
      baseFiles({
        'src/y.ts': '/*\tistanbul\tignore next */\nexport const b = 1\n',
      }),
    )
    expect(
      rTab.violations.some((v) => v.ruleId === 'ignore-comment-added'),
    ).toBe(true)
  })

  it('burn-in / e2e / kind detectors', () => {
    expect(isBurnInRun('pnpm --repeat-each=3')).toBe(true)
    expect(isBurnInRun('pnpm test:e2e')).toBe(false)
    expect(isE2eStep('pnpm test:e2e', 'pnpm test:e2e')).toBe(true)
    expect(
      isE2eStep('--repeat-each=2', 'playwright test --repeat-each=2'),
    ).toBe(false)
    expect(detectGateKindsFromBlob('x', 'pnpm test:coverage')).toContain(
      'coverage',
    )
    expect(detectGateKindsFromBlob('x', 'vitest run --coverage')).toContain(
      'coverage',
    )
    expect(detectGateKindsFromBlob('x', 'vitest --coverage')).toContain(
      'coverage',
    )
    expect(runFailsOnNeeds('# exit 1\necho ok')).toBe(false)
    expect(runFailsOnNeeds('exit 1')).toBe(false)
    expect(
      runFailsOnNeeds(
        'if [ "${{ needs.unit.result }}" != "success" ]; then exit 1; fi',
      ),
    ).toBe(true)
    expect(
      runFailsOnNeeds('if [ "$BURN_IN_RESULT" != "success" ]; then exit 1; fi'),
    ).toBe(true)
  })

  it('listSourcePaths filters and isWorkflowYmlPath', () => {
    expect(
      listSourcePaths({
        'src/a.ts': '1',
        'src/a.test.ts': '1',
        'openspec/x.ts': '1',
        'node_modules/x/a.js': '1',
        'readme.md': '1',
      }),
    ).toEqual(['src/a.ts'])
    expect(isWorkflowYmlPath('.github/workflows/ci.yml')).toBe(true)
    expect(isWorkflowYmlPath('.github/workflows/ci.yaml')).toBe(false)
    expect(isWorkflowYmlPath('docs/workflows/ci.yml')).toBe(false)
  })

  it('coveredKindsForJob and jobsProvidingKind', () => {
    const jobs = analyzeWorkflowJobs(
      parseYaml(`
jobs:
  unit:
    steps:
      - run: pnpm test:coverage
  gate:
    needs: [unit]
    steps:
      - run: echo ok
`),
    )
    expect([...coveredKindsForJob(jobs, 'gate')]).toContain('coverage')
    expect(coveredKindsForJob(jobs, 'missing').size).toBe(0)
    expect(jobsProvidingKind(jobs, 'coverage')).toEqual(['unit'])
  })

  it('compareRequiredJobGates fails when required job removed', () => {
    const msgs = []
    compareRequiredJobGates(
      baseFiles(),
      baseFiles({
        '.github/workflows/checks.yml': `
jobs:
  other:
    steps:
      - run: echo ok
`,
      }),
      ['checks'],
      (m) => msgs.push(m),
    )
    expect(msgs).toContain('required job checks removed')
  })

  it('compareGateTrees flags stryker weakerFlags and package.json parse fail', () => {
    const headStryker = `
const config = {
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  disableTypeChecks: true,
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
}
export default config
`
    const r = compareGateTrees(
      baseFiles(),
      baseFiles({ 'stryker.config.mjs': headStryker }),
    )
    expect(r.violations).toContainEqual({
      ruleId: 'stryker-weaker',
      message: 'stryker weaker: disableTypeChecks',
    })

    const badPkg = compareGateTrees(
      baseFiles(),
      baseFiles({ 'package.json': '{not-json' }),
    )
    expect(
      badPkg.violations.some(
        (v) =>
          v.ruleId === 'patched-deps-grown' &&
          /package\.json parse failed/.test(v.message),
      ),
    ).toBe(true)
  })

  it('readTreeFromDir returns empty for missing root', () => {
    expect(
      readTreeFromDir(path.join(os.tmpdir(), 'no-such-gate-ratchet-dir')),
    ).toEqual({})
  })

  it('runGateRatchetCli via base-ref path on twin commits', () => {
    const repo = initTmpRepo(tmpDirs, {
      prefix: 'ratchet-refs-',
      seedFiles: baseFiles(),
    })
    const base = String(gitExec(['rev-parse', 'HEAD'], repo)).trim()
    fs.writeFileSync(
      path.join(repo, 'quality/gates.json'),
      JSON.stringify({
        ...baseGates,
        coverage: { ...baseGates.coverage, lines: 1 },
      }),
    )
    gitExec(['add', '.'], repo, { stdio: 'ignore' })
    gitExec(['commit', '-m', 'weaker'], repo, { stdio: 'ignore' })
    const head = String(gitExec(['rev-parse', 'HEAD'], repo)).trim()
    expect(
      runGateRatchetCli([
        '--cwd',
        repo,
        '--base-ref',
        base,
        '--head-ref',
        head,
      ]),
    ).toBe(1)
  })

  it('resolvePrPolicyBaseRef default git path hits spawnSync', () => {
    expect(
      resolvePrPolicyBaseRef({
        root: path.join(os.tmpdir(), 'no-such-gate-ratchet-git-root'),
        env: {},
      }),
    ).toBeNull()
  })

  it('runPrPolicyCheck uses default root when omitted (skip path)', () => {
    const logs = []
    expect(
      runPrPolicyCheck({
        env: {},
        git: () => ({ status: 1, stdout: '', stderr: '' }),
        log: (m) => logs.push(m),
      }),
    ).toBe(0)
    expect(logs.join('\n')).toMatch(/skip/)
  })

  it('compareCodecov handles null roots and non-object components', () => {
    const msgs = []
    compareCodecov(null, null, (m) => msgs.push(m))
    expect(msgs).toEqual([])
    compareCodecov(
      {
        component_management: {
          individual_components: [null, { component_id: 'core' }, 'x'],
        },
      },
      {
        component_management: {
          individual_components: [null, { component_id: 'other' }],
        },
      },
      (m) => msgs.push(m),
    )
    expect(msgs).toContain('codecov.yml component core removed')
  })

  it('classifyGateSteps tolerates null step', () => {
    expect(classifyGateSteps(null).size).toBe(0)
    expect(analyzeWorkflowJobs(null).size).toBe(0)
    expect(analyzeWorkflowJobs({}).size).toBe(0)
  })

  it('compareGatesJson budget resource missing and assertion demotion', () => {
    const msgs = []
    compareGatesJson(
      baseGates,
      {
        ...baseGates,
        lighthouse: {
          numberOfRuns: 1,
          assertions: { 'performance-budget': 'warn' },
          budgets: [
            {
              path: '/*',
              resourceSizes: [{ resourceType: 'script', budget: 400 }],
              resourceCounts: [],
            },
          ],
        },
      },
      'quality/gates.json',
      (m) => msgs.push(m),
    )
    expect(msgs).toContain(
      'quality/gates.json lighthouse.assertions.performance-budget no longer error',
    )
    expect(msgs).toContain(
      'quality/gates.json lighthouse budget script: 350 → 400',
    )

    const missing = []
    compareGatesJson(
      baseGates,
      {
        ...baseGates,
        lighthouse: {
          numberOfRuns: 1,
          assertions: { 'performance-budget': 'error' },
          budgets: [{ path: '/other', resourceSizes: [], resourceCounts: [] }],
        },
      },
      'quality/gates.json',
      (m) => missing.push(m),
    )
    expect(missing).toContain(
      'quality/gates.json lighthouse.budgets path missing: /*',
    )
  })

  it('requiredCheckJobs removed when head is not an array', () => {
    const msgs = []
    compareGatesJson(
      baseGates,
      { ...baseGates, requiredCheckJobs: null },
      'quality/gates.json',
      (m) => msgs.push(m),
    )
    expect(msgs).toContain('quality/gates.json requiredCheckJobs removed')
  })

  it('covers null fallbacks when gate files are missing on one side', () => {
    const base = baseFiles()
    const head = baseFiles()
    delete head['vite.config.ts']
    delete head['stryker.config.mjs']
    delete head['package.json']
    delete head['scripts/check-gate-ratchet.mjs']
    delete head['scripts/check-gate-ratchet.test.mjs']
    const r = compareGateTrees(base, head)
    expect(r.violations.some((v) => v.ruleId === 'gate-file-gone')).toBe(true)
    expect(r.violations.some((v) => v.ruleId === 'include-removed')).toBe(true)

    // Both sides missing vite/stryker → empty-string fallbacks (no include delta).
    const bareBase = baseFiles()
    const bareHead = baseFiles()
    for (const tree of [bareBase, bareHead]) {
      delete tree['vite.config.ts']
      delete tree['stryker.config.mjs']
    }
    const bare = compareGateTrees(bareBase, bareHead)
    expect(
      bare.violations.filter((v) =>
        ['include-removed', 'exclude-added', 'stryker-weaker'].includes(
          v.ruleId,
        ),
      ),
    ).toEqual([])
  })

  it('covers codecov and required-job catch messages exactly', () => {
    const badYaml = compareGateTrees(
      baseFiles(),
      baseFiles({ 'codecov.yml': ':\nbad' }),
    )
    expect(
      badYaml.violations.some(
        (v) =>
          v.ruleId === 'codecov-weaker' &&
          v.message.startsWith('failed to parse codecov.yml:'),
      ),
    ).toBe(true)

    // Invalid workflow YAML throws inside compareRequiredJobGates(parseYaml);
    // compareGateTrees catches it onto required-job-step-moved.
    const broken = baseFiles({
      '.github/workflows/checks.yml': 'jobs:\n  checks:\n    steps: [',
    })
    const r = compareGateTrees(baseFiles(), broken)
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'required-job-step-moved' &&
          v.message.startsWith('required-job check failed:'),
      ),
    ).toBe(true)
  })

  it('runGateRatchetCli default argv uses process.argv', () => {
    const prev = process.argv
    process.argv = [prev[0], prev[1]]
    try {
      expect(runGateRatchetCli()).toBe(2)
    } finally {
      process.argv = prev
    }
  })

  it('covers non-array paths/steps and auto percent skips', () => {
    const msgs = []
    compareCodecov(
      {
        coverage: {
          status: {
            patch: { default: { target: '85%', threshold: '0%' } },
          },
        },
        flags: { unit: { paths: ['src/'] } },
      },
      {
        coverage: {
          status: {
            patch: { default: { target: 'auto', threshold: 'auto' } },
          },
        },
        flags: { unit: { paths: 'not-an-array' } },
      },
      (m) => msgs.push(m),
    )
    expect(msgs.filter((m) => m.includes('.target:'))).toEqual([])
    expect(msgs.filter((m) => m.includes('.threshold:'))).toEqual([])
    // Non-array head paths → treated as empty → path removal reported.
    expect(msgs).toContain('codecov.yml flags.unit.paths removed src/')

    const jobs = analyzeWorkflowJobs({
      jobs: {
        bare: { steps: null },
        named: { needs: 'unit', steps: { not: 'array' } },
      },
    })
    expect(jobs.get('bare')?.kinds.size).toBe(0)
    expect(jobs.get('named')?.needs).toEqual(['unit'])
    expect(jobs.get('named')?.kinds.size).toBe(0)

    const r = compareGateTrees(
      baseFiles({
        'quality/gates.json': JSON.stringify({
          ...baseGates,
          requiredCheckJobs: 'checks',
        }),
      }),
      baseFiles(),
    )
    // Non-array requiredCheckJobs → empty list → no required-job checks run.
    expect(
      r.violations.filter((v) => v.ruleId === 'required-job-step-moved'),
    ).toEqual([])
  })

  it('gate file present only on head does not trip gate-file-gone', () => {
    const base = baseFiles()
    delete base['codecov.yml']
    const head = baseFiles()
    const r = compareGateTrees(base, head)
    expect(
      r.violations.filter(
        (v) =>
          v.ruleId === 'gate-file-gone' && v.message.includes('codecov.yml'),
      ),
    ).toEqual([])
  })

  it('flat arrays with brackets inside quotes stay intact', () => {
    expect(extractFirstKeyedArray(`mutate: ['a[b]', "c]d"]`, 'mutate')).toEqual(
      ['a[b]', 'c]d'],
    )
    expect(extractFirstKeyedArray(`mutate: ["only-double"]`, 'mutate')).toEqual(
      ['only-double'],
    )
    expect(extractFirstKeyedArray(`mutate: ['only-single']`, 'mutate')).toEqual(
      ['only-single'],
    )
  })

  it('parsePercentish digit scan rejects mixed junk', () => {
    expect(parsePercentish('12.5%')).toBe(12.5)
    expect(parsePercentish('12.5.6')).toBeNull()
    expect(parsePercentish('1a')).toBeNull()
    expect(parsePercentish(Infinity)).toBeNull()
    expect(numberWeaker(1, 2, NEEDLES.lowerStricter)).toBe(true)
    expect(numberWeaker(2, 1, NEEDLES.higherStricter)).toBe(true)
    expect(numberWeaker(1, 1, NEEDLES.higherStricter)).toBe(false)
    // Non-number args must stay false (kills type-guard mutants).
    expect(numberWeaker('80', 70, NEEDLES.higherStricter)).toBe(false)
    expect(numberWeaker(80, '70', NEEDLES.higherStricter)).toBe(false)
    expect(numberWeaker(null, 1, NEEDLES.lowerStricter)).toBe(false)
  })

  it('informational flip requires exact !== true / === true', () => {
    const msgs = []
    compareCodecov(
      {
        coverage: {
          status: {
            patch: {
              default: { target: '85%', threshold: '0%', informational: false },
            },
          },
        },
      },
      {
        coverage: {
          status: {
            patch: {
              default: { target: '85%', threshold: '0%', informational: true },
            },
          },
        },
      },
      (m) => msgs.push(m),
    )
    expect(msgs).toEqual([
      'codecov.yml coverage.status.patch.default informational turned on',
    ])

    const noFlip = []
    compareCodecov(
      {
        coverage: {
          status: {
            patch: {
              default: { target: '85%', threshold: '0%', informational: true },
            },
          },
        },
      },
      {
        coverage: {
          status: {
            patch: {
              default: { target: '85%', threshold: '0%', informational: true },
            },
          },
        },
      },
      (m) => noFlip.push(m),
    )
    expect(noFlip).toEqual([])
  })

  it('exact MSGS-backed gate-file-gone messages', () => {
    const head = baseFiles()
    delete head['quality/gates.json']
    const r = compareGateTrees(baseFiles(), head)
    expect(r.violations).toContainEqual({
      ruleId: 'gate-file-gone',
      message: MSGS.gatesJsonDeleted,
    })
    expect(r.violations).toContainEqual({
      ruleId: 'gate-file-gone',
      message: `${MSGS.gateFileMissingPrefix}quality/gates.json`,
    })

    const head2 = baseFiles()
    delete head2['codecov.yml']
    const r2 = compareGateTrees(baseFiles(), head2)
    expect(r2.violations).toContainEqual({
      ruleId: 'gate-file-gone',
      message: MSGS.codecovDeleted,
    })
  })
})

describe('scripts glob include / paired excludes', () => {
  const thinCli = `#!/usr/bin/env node
import { main } from './agent.mjs'
main(process.argv.slice(2), process)
`

  it('subsumes hand-listed script includes under scripts/**/*.mjs', () => {
    expect(
      coverageIncludeCovered('scripts/agent.mjs', ['scripts/**/*.mjs']),
    ).toBe(true)
    expect(hasScriptsCoverageInclude(['scripts/**/*.mjs'])).toBe(true)
    const base = baseFiles({
      'vite.config.ts': `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/agent.mjs'],
      exclude: [],
    },
  },
}
`,
    })
    const head = baseFiles({
      'vite.config.ts': `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: ['scripts/**/*.test.mjs', 'scripts/agent-cli.mjs'],
    },
  },
}
`,
      'scripts/agent-cli.mjs': thinCli,
    })
    const r = compareGateTrees(base, head)
    expect(r.ok).toBe(true)
  })

  it('removing scripts/**/*.mjs include fails pr-policy', () => {
    const withGlob = `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: [],
    },
  },
}
`
    const without = `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [],
    },
  },
}
`
    const r = compareGateTrees(
      baseFiles({ 'vite.config.ts': withGlob }),
      baseFiles({ 'vite.config.ts': without }),
    )
    expect(r.ok).toBe(false)
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'include-removed' &&
          v.message.includes('scripts/**/*.mjs'),
      ),
    ).toBe(true)
  })

  it('allows paired thin-CLI bang when scripts glob present', () => {
    expect(
      isAllowedScriptPairedExclude(
        '!scripts/agent-cli.mjs',
        { 'scripts/agent-cli.mjs': thinCli },
        ['scripts/**/*.mjs'],
      ),
    ).toBe(true)
    expect(
      isAllowedScriptPairedExclude(
        '!scripts/fat.mjs',
        {
          'scripts/fat.mjs': `${'x\n'.repeat(20)}import { a } from './b.mjs'\n`,
        },
        ['scripts/**/*.mjs'],
      ),
    ).toBe(false)
  })

  it('codecov scripts/ prefix covers former per-file paths', () => {
    expect(
      codecovFlagPathCovered('scripts/agent.mjs', ['src/', 'scripts/']),
    ).toBe(true)
    const msgs = []
    compareCodecov(
      {
        flags: {
          unit: {
            paths: ['src/', 'scripts/agent.mjs'],
          },
        },
      },
      {
        flags: {
          unit: {
            paths: ['src/', 'scripts/'],
          },
        },
      },
      (m) => msgs.push(m),
    )
    expect(msgs.some((m) => m.includes('paths removed'))).toBe(false)
  })

  function loadPr126FixtureTree(side) {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/ts-agent-rig/src/fixtures/pr-126-scripts-glob.json'),
      'utf8',
    )
    const payload = JSON.parse(raw)
    const tree = payload[side]
    if (!tree || typeof tree !== 'object') {
      throw new Error(`pr-126 fixture missing side: ${side}`)
    }
    return /** @type {Record<string, string>} */ (tree)
  }

  it('FIXTURE scripts-glob-pr126-replay: real #126 configs yield 0 violations', () => {
    expect(FIXTURE_IDS).toContain('scripts-glob-pr126-replay')
    const r = compareGateTrees(
      loadPr126FixtureTree('base'),
      loadPr126FixtureTree('head'),
    )
    expect(r.violations).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('FIXTURE scripts-include-uncovered-removed fails', () => {
    expect(FIXTURE_IDS).toContain('scripts-include-uncovered-removed')
    const headVite = `
export const coverageExcludeGlobs = ['src/**/*.d.ts'] as const
export default {
  test: {
    allowOnly: false,
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
      exclude: [...coverageExcludeGlobs],
    },
  },
}
`
    const { code, result } = cliRatchet({ 'vite.config.ts': headVite })
    expect(code).toBe(1)
    expect(
      result.violations.some(
        (v) =>
          v.ruleId === 'include-removed' &&
          v.message.includes('scripts/agent.mjs'),
      ),
    ).toBe(true)
  })

  it('FIXTURE broad-script-exclude fails for coverage exclude', () => {
    expect(FIXTURE_IDS).toContain('broad-script-exclude')
    const withGlob = `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: [],
    },
  },
}
`
    const base = baseFiles({ 'vite.config.ts': withGlob })
    const rCov = compareGateTrees(
      base,
      baseFiles({
        'vite.config.ts': `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: ['scripts/**'],
    },
  },
}
`,
      }),
    )
    expect(rCov.ok).toBe(false)
    expect(
      rCov.violations.some(
        (v) => v.ruleId === 'exclude-added' && v.message.includes('scripts/**'),
      ),
    ).toBe(true)

    const rSrc = compareGateTrees(
      base,
      baseFiles({
        'vite.config.ts': withGlob,
        'stryker.config.mjs': `
const config = {
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.ts'],
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
}
export default config
`,
      }),
    )
    expect(rSrc.ok).toBe(false)
    expect(
      rSrc.violations.some(
        (v) =>
          v.ruleId === 'exclude-added' && v.message.includes('!src/**/*.ts'),
      ),
    ).toBe(true)
  })

  it('FIXTURE non-thin-cli-exclude fails', () => {
    expect(FIXTURE_IDS).toContain('non-thin-cli-exclude')
    const fat = `${'x\n'.repeat(20)}import { a } from './b.mjs'\na()\n`
    const withGlob = `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: [],
    },
  },
}
`
    const r = compareGateTrees(
      baseFiles({ 'vite.config.ts': withGlob }),
      baseFiles({
        'vite.config.ts': `
export default {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: ['scripts/fat.mjs'],
    },
  },
}
`,
        'scripts/fat.mjs': fat,
      }),
    )
    expect(r.ok).toBe(false)
    expect(
      r.violations.some(
        (v) =>
          v.ruleId === 'exclude-added' && v.message.includes('scripts/fat.mjs'),
      ),
    ).toBe(true)
  })

  it('FIXTURE codecov-path-uncovered fails', () => {
    expect(FIXTURE_IDS).toContain('codecov-path-uncovered')
    const baseCov = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
flags:
  unit:
    paths:
      - src/
      - scripts/agent.mjs
ignore:
  - e2e/**
`
    const headCov = `
coverage:
  status:
    patch:
      default:
        target: 85%
        threshold: 0%
flags:
  unit:
    paths:
      - src/
ignore:
  - e2e/**
`
    const { code, result } = cliRatchet(
      { 'codecov.yml': headCov },
      { 'codecov.yml': baseCov },
    )
    expect(code).toBe(1)
    expect(
      result.violations.some(
        (v) =>
          v.ruleId === 'codecov-weaker' &&
          v.message.includes('scripts/agent.mjs'),
      ),
    ).toBe(true)
  })
})
