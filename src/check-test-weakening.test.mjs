import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHECKBOX_DONE,
  CHECKBOX_TODO,
  COMPANION_EXTS,
  CONFIG_KEYS,
  CRITERIA,
  DEFAULT_PARSE_FILENAME,
  DONE_NOTE_H2,
  DONE_NOTE_PREFIX,
  MSGS,
  OWNER_APPROVAL_PREFIX,
  PATHS,
  RETRIES_KEY,
  STATUS_DONE,
  STATUS_PREFIX,
  TEST_CONFIGURE,
  TEST_ROOT_DESCRIBE,
  TEST_ROOT_IT,
  TEST_ROOT_NAMES,
  TEST_ROOT_TEST,
  WEAKENING_SUFFIXES,
  companionDeletedFor,
  companionPathsFor,
  compareItemCriteria,
  compareTestWeakening,
  countWeakeningMarkers,
  extractConfigBool,
  hasOwnerApprovedScopeChange,
  isAllowedItemEdit,
  isDeferralRoadmapText,
  isItemCriteriaLine,
  isTrackedTestPath,
  listTrackedTestPaths,
  objectHasRetries,
  parseTestFile,
  slugFromBranch,
  staticStringArg,
} from './check-test-weakening.mjs'
import ts from 'typescript'

describe('parseTestFile', () => {
  it('detects skip/only/todo/fixme weakening markers', () => {
    const src = `
import { test, it, describe } from 'vitest'
test('keeps running', () => { expect(1).toBe(1) })
test.skip('skipped one', () => { expect(1).toBe(1) })
it.only('focused', () => {})
it.todo('later')
test.fixme('broken', () => {})
test.fail('will fail', () => {})
`
    const p = parseTestFile(src, 'x.test.ts')
    expect(p.weakening.map((w) => w.suffix).sort()).toEqual(
      ['fail', 'fixme', 'only', 'skip', 'todo'].sort(),
    )
  })

  it('detects describe.configure retries and per-test retries', () => {
    const src = `
import { test } from '@playwright/test'
test.describe.configure({ retries: 3 })
test('with retries', { retries: 2 }, async () => {})
test('plain', async () => {})
`
    const p = parseTestFile(src, 'e2e/x.spec.ts')
    expect(p.retries).toBe(2)
  })

  it('detects string-literal retries key', () => {
    const src = `test('with retries', { 'retries': 2 }, async () => {})\n`
    const p = parseTestFile(src, 'e2e/x.spec.ts')
    expect(p.retries).toBe(1)
  })

  it('default fileName pin parses without second arg', () => {
    const p = parseTestFile(`test('solo', () => {})`)
    expect(DEFAULT_PARSE_FILENAME).toBe('file.ts')
    expect(p.weakening).toEqual([])
  })

  it('does not count describe / configure as weakening', () => {
    const src = `
describe('suite', () => {})
test.describe('nested', () => {})
test.describe.configure({ retries: 1 })
test('real', () => {})
it('also', () => {})
`
    const p = parseTestFile(src, 'a.test.ts')
    expect(p.weakening).toEqual([])
    expect(p.retries).toBe(1)
  })

  it('objectHasRetries true only for retries key', () => {
    /**
     * @param {string} src
     */
    const objOf = (src) => {
      const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true)
      const stmt = /** @type {ts.VariableStatement} */ (sf.statements[0])
      const init = stmt.declarationList.declarations[0].initializer
      return init
    }
    expect(objectHasRetries(objOf(`const x = { retries: 1 }`))).toBe(true)
    expect(objectHasRetries(objOf(`const x = { 'retries': 2 }`))).toBe(true)
    expect(objectHasRetries(objOf(`const x = { other: 1 }`))).toBe(false)
    expect(objectHasRetries(undefined)).toBe(false)
    expect(objectHasRetries(objOf(`const x = 1`))).toBe(false)
  })

  it('staticStringArg edges', () => {
    expect(staticStringArg(undefined)).toBe(null)
  })
})

describe('path helpers', () => {
  it.each([
    ['src/foo/bar.test.ts', true],
    ['src/foo/bar.test.tsx', true],
    ['src/foo/bar.test.mjs', true],
    ['src/foo/bar.test.js', false],
    ['src/foo.ts', false],
    ['src/foo.test', false],
    ['scripts/check-gate-ratchet.test.mjs', true],
    ['scripts/x.test.js', true],
    ['scripts/x.test.ts', true],
    ['scripts/x.test.tsx', false],
    ['scripts/x.mjs', false],
    ['e2e/filmstrip.spec.ts', true],
    ['e2e/filmstrip.spec.tsx', false],
    ['e2e/filmstrip.ts', false],
    ['src/node_modules/x.test.ts', false],
    ['e2e/burn-in-fixtures/x.spec.ts', false],
    ['src\\foo\\bar.test.ts', true],
    ['scripts\\x.test.mjs', true],
  ])('isTrackedTestPath(%s) → %s', (p, want) => {
    expect(isTrackedTestPath(p)).toBe(want)
  })

  it('companionPathsFor strips test/spec suffix for each ext', () => {
    expect(companionPathsFor('src/foo/bar.test.ts')).toEqual([
      'src/foo/bar.ts',
      'src/foo/bar.tsx',
      'src/foo/bar.mjs',
      'src/foo/bar.js',
    ])
    expect(companionPathsFor('scripts/x.test.mjs')).toEqual([
      'scripts/x.ts',
      'scripts/x.tsx',
      'scripts/x.mjs',
      'scripts/x.js',
    ])
    expect(companionPathsFor('src/foo/bar.test.tsx')).toContain(
      'src/foo/bar.tsx',
    )
    expect(companionPathsFor('scripts/x.test.js')).toContain('scripts/x.js')
    expect(companionPathsFor('e2e/filmstrip.spec.ts')).toEqual([
      'e2e/filmstrip.ts',
      'e2e/filmstrip.tsx',
      'e2e/filmstrip.mjs',
      'e2e/filmstrip.js',
      'src/filmstrip.ts',
      'src/filmstrip.tsx',
      'src/filmstrip/index.ts',
    ])
    expect(companionPathsFor('e2e/nested/x.spec.tsx')).toEqual([
      'e2e/nested/x.ts',
      'e2e/nested/x.tsx',
      'e2e/nested/x.mjs',
      'e2e/nested/x.js',
      'src/x.ts',
      'src/x.tsx',
      'src/x/index.ts',
    ])
    expect(companionPathsFor('readme.md')).toEqual([])
    expect(companionPathsFor('src\\foo\\bar.test.ts')).toContain(
      'src/foo/bar.ts',
    )
  })

  it('companionDeletedFor matches e2e stem against deleted src basename', () => {
    expect(
      companionDeletedFor(
        'e2e/filmstrip.spec.ts',
        { 'src/editor/Filmstrip.tsx': 'x' },
        {},
      ),
    ).toBe(true)
    expect(
      companionDeletedFor(
        'e2e/filmstrip.spec.ts',
        { 'src/editor/Filmstrip.tsx': 'x' },
        { 'src/editor/Filmstrip.tsx': 'x' },
      ),
    ).toBe(false)
    expect(
      companionDeletedFor(
        'e2e/filmstrip.spec.ts',
        { 'lib/Filmstrip.tsx': 'x' },
        {},
      ),
    ).toBe(false)
    expect(
      companionDeletedFor('src/foo.test.ts', { 'src/foo.ts': 'x' }, {}),
    ).toBe(true)
    expect(
      companionDeletedFor('src/foo.test.ts', { 'src/other.ts': 'x' }, {}),
    ).toBe(false)
    expect(
      companionDeletedFor(
        'e2e/filmstrip.spec.ts',
        { 'src/filmstrip.ts': 'x' },
        {},
      ),
    ).toBe(true)
    expect(
      companionDeletedFor(
        'e2e/filmstrip.spec.ts',
        { 'src/filmstrip.utils.ts': 'x' },
        {},
      ),
    ).toBe(true)
    expect(
      companionDeletedFor(
        'e2e/filmstrip.spec.ts',
        { 'src/filmstripx.ts': 'x' },
        {},
      ),
    ).toBe(false)
  })

  it('listTrackedTestPaths filters and sorts', () => {
    expect(
      listTrackedTestPaths({
        'src/z.test.ts': 'a',
        'src/a.test.ts': 'b',
        'src/skip.ts': 'c',
        'e2e/x.spec.ts': 'd',
      }),
    ).toEqual(['e2e/x.spec.ts', 'src/a.test.ts', 'src/z.test.ts'])
  })
})

describe('extractConfigBool / approval / slug', () => {
  it('reads true/false/other', () => {
    expect(extractConfigBool('allowOnly: false,', 'allowOnly')).toBe('false')
    expect(extractConfigBool('forbidOnly: true,', 'forbidOnly')).toBe('true')
    expect(extractConfigBool('forbidOnly: isCi,', 'forbidOnly')).toBe('other')
    expect(extractConfigBool('x: 1', 'allowOnly')).toBe(null)
    expect(extractConfigBool(null, 'allowOnly')).toBe(null)
  })

  it('detects owner approval line', () => {
    expect(
      hasOwnerApprovedScopeChange(
        'Hello\nOwner-approved scope change: https://example.com\n',
      ),
    ).toBe(true)
    expect(hasOwnerApprovedScopeChange('Owner-approved scope change:')).toBe(
      false,
    )
    expect(
      hasOwnerApprovedScopeChange(
        'Owner-approved scope change:\n- raised disableBudget to 10\n',
      ),
    ).toBe(true)
    expect(hasOwnerApprovedScopeChange('')).toBe(false)
    expect(
      hasOwnerApprovedScopeChange(`${OWNER_APPROVAL_PREFIX} https://x\r\nmore`),
    ).toBe(true)
  })

  it('slugFromBranch', () => {
    expect(slugFromBranch('feat/gate-weakening-guard')).toBe(
      'gate-weakening-guard',
    )
    expect(slugFromBranch('fix/abc')).toBe('abc')
    expect(slugFromBranch('main')).toBe(null)
    expect(slugFromBranch('feat/a/b')).toBe(null)
    expect(slugFromBranch('  feat/x  ')).toBe('x')
    expect(slugFromBranch(null)).toBe(null)
  })
})

describe('item criteria helpers', () => {
  it('allows checkbox ticks, status done, Done note', () => {
    const base = `# item\nStatus: open\n- [ ] A\n- [ ] B\n`
    const head = `# item\nStatus: done\n- [x] A\n- [x] B\n\n## Done note\nShipped.\n`
    expect(isAllowedItemEdit(base, head)).toBe(true)
  })

  it('allows Done note: inline prefix', () => {
    const base = `# item\nStatus: open\n- [ ] A\n`
    const head = `# item\nStatus: done\n- [x] A\n\nDone note: shipped via PR\n`
    expect(isAllowedItemEdit(base, head)).toBe(true)
  })

  it('allows inserting Status: done when base had none', () => {
    const base = `# item\nTitle: t\n\n## Scope\n- [ ] A\n`
    const head = `# item\nTitle: t\nStatus: done\n\n## Scope\n- [x] A\n\n## Done note\nShipped.\n`
    expect(isAllowedItemEdit(base, head)).toBe(true)
  })

  it('rejects Status: alone without value on base', () => {
    const base = `# item\nStatus:\n- [ ] A\n`
    const head = `# item\nStatus: done\n- [x] A\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('rejects when base has trailing lines not in head', () => {
    // Exhaust head first so bi < base.length return false is reached (not mid-loop).
    expect(isAllowedItemEdit('A\nB\nC', 'A\nB')).toBe(false)
    const base = `# item\nStatus: open\n- [ ] A\nextra\n`
    const head = `# item\nStatus: done\n- [x] A\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('inserts Status: done even when base line ends with Status: prefix', () => {
    const base = `# item\nMy Status:\n- [ ] A\n`
    const head = `# item\nStatus: done\nMy Status:\n- [x] A\n\n## Done note\nOk.\n`
    expect(isAllowedItemEdit(base, head)).toBe(true)
  })

  it('rejects case-variant Done note headings (exact pin only)', () => {
    const base = `# item\nStatus: open\n- [ ] A\n`
    const head = `# item\nStatus: done\n- [x] A\n\n## done note\nShipped.\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('rejects non-blank trailing junk before Done note', () => {
    const base = `# item\nStatus: open\n- [ ] A\n`
    const head = `# item\nStatus: done\n- [x] A\norphan\n## Done note\nOk.\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('rejects Done-when rewrite', () => {
    const base = `## Scope\n- **Done when:** keep bar\n`
    const head = `## Scope\n- **Done when:** weaker bar\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('rejects ## Done when (revised) trailing bypass', () => {
    const base = `# item\nStatus: open\n- [ ] A\n`
    const head = `${base}\n## Done when (revised)\n\nOnly lint passes; mutation bar deferred.\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('rejects blank lines then Done-when rewrite trailing bypass', () => {
    const base = `# item\nStatus: open\n- [ ] A\n`
    const head = `${base}\n\n- **Done when:** lint passes only\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it('rejects Done-when line after ## Done note', () => {
    const base = `# item\nStatus: open\n- [ ] A\n`
    const head = `# item\nStatus: done\n- [x] A\n\n## Done note\nShipped.\n- **Done when:** weaker\n`
    expect(isAllowedItemEdit(base, head)).toBe(false)
  })

  it.each([
    ['## Done when', true],
    ['## Done when extra', true],
    ['## Scope', true],
    ['## Scope more', true],
    ['- **Done when:** x', true],
    ['- **Size:** S', true],
    ['- [ ] task', true],
    ['- [x] task', true],
    ['- [X] task', true],
    ['Shipped.', false],
    ['## Done note', false],
    ['Status: done', false],
  ])('isItemCriteriaLine(%j) → %s', (line, want) => {
    expect(isItemCriteriaLine(line)).toBe(want)
  })

  it('detects deferral text', () => {
    expect(
      isDeferralRoadmapText(
        'defer mutation bar for gate-weakening-guard',
        'gate-weakening-guard',
      ),
    ).toBe(true)
    expect(isDeferralRoadmapText('defer coverage later', '')).toBe(true)
    expect(isDeferralRoadmapText('follow-up on NoCoverage', 'x')).toBe(true)
    expect(isDeferralRoadmapText('instead of meeting e2e', '')).toBe(true)
    expect(isDeferralRoadmapText('defer something else', '')).toBe(false)
    expect(isDeferralRoadmapText('unrelated note', 'other')).toBe(false)
    expect(isDeferralRoadmapText('mentions other slug here', 'other')).toBe(
      true,
    )
  })
})

describe('compareTestWeakening', () => {
  it('fails on added skip', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareTestWeakening(
      { 'src/a.test.ts': `test('a', () => {})\n` },
      { 'src/a.test.ts': `test.skip('a', () => {})\n` },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toContainEqual({
      ruleId: MSGS.ruleTestSkipAdded,
      message: `${MSGS.weakeningAddedPrefix}src/a.test.ts`,
    })
  })

  it('fails on added retries', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareTestWeakening(
      { 'e2e/a.spec.ts': `test('a', async () => {})\n` },
      {
        'e2e/a.spec.ts': `test('a', { retries: 1 }, async () => {})\n`,
      },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toContainEqual({
      ruleId: MSGS.ruleTestRetriesAdded,
      message: `${MSGS.retriesAddedPrefix}e2e/a.spec.ts`,
    })
  })

  it('fails file delete alone; passes with companion', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const alone = []
    compareTestWeakening(
      {
        'src/foo.test.ts': `test('a', () => {})\n`,
        'src/foo.ts': `export const x = 1\n`,
      },
      { 'src/foo.ts': `export const x = 1\n` },
      (ruleId, message) => alone.push({ ruleId, message }),
    )
    expect(alone.some((x) => x.ruleId === 'test-file-deleted')).toBe(true)

    /** @type {{ ruleId: string, message: string }[]} */
    const both = []
    compareTestWeakening(
      {
        'src/foo.test.ts': `test('a', () => {})\n`,
        'src/foo.ts': `export const x = 1\n`,
      },
      {},
      (ruleId, message) => both.push({ ruleId, message }),
    )
    expect(both.some((x) => x.ruleId === 'test-file-deleted')).toBe(false)
  })

  it('passes e2e delete when matching src basename deleted', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareTestWeakening(
      {
        'e2e/filmstrip.spec.ts': `test('a', async () => {})\n`,
        'src/editor/Filmstrip.tsx': `export {}\n`,
      },
      {},
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v.some((x) => x.ruleId === 'test-file-deleted')).toBe(false)
  })

  it('fails allowOnly/forbidOnly weakening', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareTestWeakening(
      {
        'vite.config.ts': `export default { test: { allowOnly: false } }\n`,
        'playwright.config.ts': `export default { forbidOnly: true }\n`,
      },
      {
        'vite.config.ts': `export default { test: { allowOnly: true } }\n`,
        'playwright.config.ts': `export default { forbidOnly: false }\n`,
      },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toContainEqual({
      ruleId: MSGS.ruleAllowOnlyWeaker,
      message: `${MSGS.allowOnlyWeakerPrefix}false${MSGS.weakerArrow}true`,
    })
    expect(v).toContainEqual({
      ruleId: MSGS.ruleForbidOnlyWeaker,
      message: `${MSGS.forbidOnlyWeakerPrefix}true${MSGS.weakerArrow}false`,
    })
  })

  it('fails deleted file with exact MSGS prefix', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareTestWeakening(
      { 'src/solo.test.ts': `test('a', () => {})\n` },
      {},
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toContainEqual({
      ruleId: MSGS.ruleTestFileDeleted,
      message: `${MSGS.testFileDeletedPrefix}src/solo.test.ts`,
    })
  })

  it('identical files and new-only files do not fail', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    const same = `test('a', () => {})\n`
    compareTestWeakening(
      { 'src/a.test.ts': same },
      { 'src/a.test.ts': same, 'src/b.test.ts': same },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toEqual([])
  })
})

describe('compareItemCriteria', () => {
  const item = 'docs/roadmap/M2.1/demo-slug.md'
  const baseItem = `# demo-slug\nStatus: open\n- [ ] Scope A\n- **Done when:** hard bar\n`

  it('fails Done-when rewrite without approval', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareItemCriteria(
      { [item]: baseItem },
      { [item]: baseItem.replace('hard bar', 'soft bar') },
      { branch: 'feat/demo-slug', prBody: '' },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v.some((x) => x.ruleId === 'item-criteria-loosened')).toBe(true)
  })

  it('passes checkbox + Done note', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    const head = `# demo-slug\nStatus: done\n- [x] Scope A\n- **Done when:** hard bar\n\n## Done note\nNote.\n`
    compareItemCriteria(
      { [item]: baseItem },
      { [item]: head },
      { branch: 'feat/demo-slug', prBody: '' },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v.some((x) => x.ruleId === 'item-criteria-loosened')).toBe(false)
  })

  it('detects slug from changed item when branch missing', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareItemCriteria(
      { [item]: baseItem },
      { [item]: baseItem.replace('hard bar', 'soft bar') },
      { branch: '', prBody: '' },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v.some((x) => x.ruleId === 'item-criteria-loosened')).toBe(true)
  })

  it('ignores INTRO/README changes when detecting slug', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareItemCriteria(
      {
        'docs/roadmap/M2.1/INTRO.md': 'old',
        'docs/roadmap/M2.1/README.md': 'old',
      },
      {
        'docs/roadmap/M2.1/INTRO.md': 'new intro',
        'docs/roadmap/M2.1/README.md': 'new readme',
      },
      { branch: '', prBody: '' },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toEqual([])
  })

  it('skips new INTRO/README deferral files', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareItemCriteria(
      { [item]: baseItem },
      {
        [item]: baseItem,
        'docs/roadmap/M2.1/INTRO.md': 'defer mutation coverage\n',
        'docs/roadmap/M2.1/README.md': 'defer e2e later\n',
      },
      { branch: 'feat/demo-slug', prBody: '' },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v).toEqual([])
  })

  it('fails deferral item; passes with owner approval', () => {
    /** @type {{ ruleId: string, message: string }[]} */
    const v = []
    compareItemCriteria(
      { [item]: baseItem },
      {
        [item]: baseItem,
        'docs/roadmap/M2.1/demo-slug-defer.md':
          'defer mutation coverage for demo-slug\n',
      },
      { branch: 'feat/demo-slug', prBody: '' },
      (ruleId, message) => v.push({ ruleId, message }),
    )
    expect(v.some((x) => x.ruleId === 'item-criteria-loosened')).toBe(true)

    /** @type {{ ruleId: string, message: string }[]} */
    const ok = []
    compareItemCriteria(
      { [item]: baseItem },
      {
        [item]: baseItem.replace('hard bar', 'soft bar'),
        'docs/roadmap/M2.1/demo-slug-defer.md':
          'defer mutation for demo-slug\n',
      },
      {
        branch: 'feat/demo-slug',
        prBody: 'Owner-approved scope change: https://example.com/x',
      },
      (ruleId, message) => ok.push({ ruleId, message }),
    )
    expect(ok.some((x) => x.ruleId === 'item-criteria-loosened')).toBe(false)
  })
})

describe('real repo inventory', () => {
  // Package-owned fixture resolved from this file: no host repo, no cwd.
  const FIXTURE_ROOT = fileURLToPath(
    new URL('../testdata/test-weakening-inventory', import.meta.url),
  )

  /**
   * Walk a miniature tree that mirrors tracked path kinds (src/scripts/e2e
   * extensions + burn-in-fixtures exclusion). Same skip rules as the former
   * full-repo inventory walk.
   * @param {string} root
   * @returns {Record<string, string>}
   */
  const walkTrackedTests = (root) => {
    /** @type {Record<string, string>} */
    const files = {}
    const walk = (dir, relBase = '') => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (
          ent.name === 'node_modules' ||
          ent.name === '.git' ||
          ent.name === 'dist'
        ) {
          continue
        }
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(abs, rel)
        else if (ent.isFile() && isTrackedTestPath(rel)) {
          files[rel] = fs.readFileSync(abs, 'utf8')
        }
      }
    }
    walk(path.join(root, 'src'), 'src')
    walk(path.join(root, 'scripts'), 'scripts')
    walk(path.join(root, 'e2e'), 'e2e')
    return files
  }

  it('parses weakening markers from real test files', () => {
    expect(
      fs.existsSync(
        path.join(FIXTURE_ROOT, 'e2e/burn-in-fixtures/ignored.spec.ts'),
      ),
    ).toBe(true)
    const files = walkTrackedTests(FIXTURE_ROOT)
    expect(Object.keys(files).some((p) => p.includes('burn-in-fixtures'))).toBe(
      false,
    )
    expect(Object.keys(files).sort()).toEqual([
      'e2e/sample.spec.ts',
      'scripts/sample.test.js',
      'scripts/sample.test.mjs',
      'scripts/sample.test.ts',
      'src/feature/sample.test.mjs',
      'src/feature/sample.test.ts',
      'src/feature/sample.test.tsx',
    ])
    expect(countWeakeningMarkers(files)).toBeGreaterThanOrEqual(0)
  })
})
