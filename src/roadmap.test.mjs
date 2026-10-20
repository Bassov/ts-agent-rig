import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertOpenItem,
  bootRoadmapCli,
  checkWrapperArgs,
  cmdArchive,
  cmdCheck,
  cmdSync,
  execCheckWrapper,
  folderName,
  genSlug,
  load,
  main,
  parseHeadline,
  parseIndex,
  parseItemFile,
  parseSource,
  renderItemFile,
  run,
  stripMeta,
  textFormat,
  verifyMigration,
  withFileStatus,
} from './roadmap.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, 'roadmap.mjs')
const REPO = path.resolve(here, '../../..')

function ensureZ9SectionInRoadmapIndex(idxPath) {
  let text = fs.readFileSync(idxPath, 'utf8')
  if (!text.includes('## Z9')) {
    text = text.replace(
      '## Deferred',
      '## Z9 — Empty\n\nGoal: empty.\n\n## Deferred',
    )
    fs.writeFileSync(idxPath, text)
  }
  return text
}

// Monolithic-roadmap fixture with the parsing edge cases (kept inline so Prettier never reformats it).
const SOURCE_TEXT = `# Roadmap

Header paragraph.

This file is the single source of truth for the fixture.

## How to use

- Each top-level checkbox is one change.

### Change size

Grow in place.

## Order

1. A then B.

## A0 — Done milestone

- [x] Tooling, CI and things
- [X] \`old-slug\` — uppercase done, no tag
- [x] Tooling, CI and things

## A1 — First

**Review cut:** first goal.

**Order:** second paragraph.

- [x] [prep] \`alpha\` — alpha title (Security Review: x)
  - [x] nested done
  - **Done when:** alpha passes.
- [ ] [feature] \`beta\` — beta title
  - [ ] nested scope

  - **Browser check:** after a blank line inside the item
Non-indented paragraph that belongs to beta.

- [ ] [contingency] \`gamma\` — only if beta fails
- [ ] [prep] \`delta\` — delta — with a dash in title
### Sub heading inside delta
  - [ ] still delta

## A2 — Second

**Review cut:** one.

**Two:** two.

**Three:** three.

**Four:** four.

- [ ] [feature] \`epsilon\` — epsilon title
  - [ ] eps scope
- [ ] [prep] \`zeta\` — zeta title

## Deferred (not scheduled)

- Some idea
- Another idea
`
const RULES_TEXT = '# Roadmap process\n\nUse the CLI.\n'
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-fixture-'))
const SOURCE = path.join(fixtureDir, 'source.md')
const RULES = path.join(fixtureDir, 'RULES.md')
fs.writeFileSync(SOURCE, SOURCE_TEXT)
fs.writeFileSync(RULES, RULES_TEXT)

/** LCS line diff: { removed, added } lines between two texts. */
/** LCS line diff: returns { removed: [lines], added: [lines] } */
function lineDiff(a, b) {
  const A = a.split('\n'),
    B = b.split('\n')
  const n = A.length,
    m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        A[i] === B[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
  const removed = [],
    added = []
  let i = 0,
    j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(A[i++])
    else added.push(B[j++])
  }
  while (i < n) removed.push(A[i++])
  while (j < m) added.push(B[j++])
  return { removed, added }
}

const created = [fixtureDir]
afterAll(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true })
})
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-test-'))
  created.push(d)
  return d
}
function migrated() {
  const root = tmp()
  const r = run(['migrate', SOURCE, '--root', root])
  expect(r.code, r.err || r.out).toBe(0)
  return root
}
const idx = (root) =>
  fs.readFileSync(path.join(root, 'docs/roadmap.md'), 'utf8')
const exists = (root, p) => fs.existsSync(path.join(root, p))
const cli = (root, ...args) => run([...args, '--root', root])
function ok(root, ...args) {
  const r = cli(root, ...args)
  expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0)
  return r.out
}
function assertCheck(root) {
  const r = cmdCheck(load(root))
  expect(r.errors).toEqual([])
}

const order = (root) => load(root).items.map((i) => i.slug)

describe('parsing', () => {
  const src = parseSource(fs.readFileSync(SOURCE, 'utf8'))
  const ms = (id) => src.sections.find((s) => s.id === id)
  it('sections and milestones', () => {
    expect(src.sections.map((s) => s.id ?? s.title)).toEqual([
      'How to use',
      'Order',
      'A0',
      'A1',
      'A2',
      'Deferred (not scheduled)',
    ])
    expect(src.header).toEqual([
      '# Roadmap',
      '',
      'Header paragraph.',
      '',
      'This file is the single source of truth for the fixture.',
      '',
    ])
  })
  it('item ends at next top-level item; blank lines and non-indented paragraphs belong to the item', () => {
    const beta = ms('A1').items.find((i) => i.slug === 'beta')
    expect(beta.body).toEqual([
      '  - [ ] nested scope',
      '',
      '  - **Browser check:** after a blank line inside the item',
      'Non-indented paragraph that belongs to beta.',
    ])
  })
  it('item ends at ## heading, ### stays inside, trailing blanks dropped', () => {
    const delta = ms('A1').items.find((i) => i.slug === 'delta')
    expect(delta.body).toEqual([
      '### Sub heading inside delta',
      '  - [ ] still delta',
    ])
    expect(ms('A2').items.at(-1).body).toEqual([])
  })
  it('milestone intro = text before first item', () => {
    expect(ms('A1').intro.filter(Boolean)).toEqual([
      '**Review cut:** first goal.',
      '**Order:** second paragraph.',
    ])
  })
  it('headline variants', () => {
    expect(parseHeadline('[prep] `a-b` — t — u')).toEqual({
      tag: 'prep',
      slug: 'a-b',
      title: 't — u',
    })
    expect(parseHeadline('`old-slug` — x')).toEqual({
      tag: null,
      slug: 'old-slug',
      title: 'x',
    })
    expect(parseHeadline('Plain text, here')).toEqual({
      tag: null,
      slug: null,
      title: 'Plain text, here',
    })
    expect(parseHeadline('`Not A Slug` thing')).toEqual({
      tag: null,
      slug: null,
      title: '`Not A Slug` thing',
    })
  })
  it('uppercase X is done; generated slugs are kebab-case and unique', () => {
    const a0 = ms('A0').items
    expect(a0.every((i) => i.done)).toBe(true)
    expect(a0.map((i) => i.slug)).toEqual([
      'tooling-ci-and-things',
      'old-slug',
      'tooling-ci-and-things-2',
    ])
    expect(genSlug('Photo card: open one local image, EXIF')).toBe(
      'photo-card-open-one-local',
    )
  })
  it('folder names', () => {
    expect(folderName('M2.1')).toBe('M2.1')
    expect(folderName('M 3/x')).toBe('M-3-x')
  })
  it('index parser flags nested / malformed / non-item lines', () => {
    const p = parseIndex(
      '# R\n\n## M1 — t\n\ngoal\n\n- [ ] [prep] [a](roadmap/M1/a.md) — a\n  - [ ] nested\n- [ ] bad line\ntext after\n',
    )
    expect(p.items.length).toBe(1)
    expect(p.problems.map((x) => x.line)).toEqual([7, 8, 9])
    expect(p.milestones[0].goal).toEqual(['goal'])
  })
})

describe('migrate', () => {
  it('layout, archive of finished milestone, verification', () => {
    const root = tmp()
    const r = run(['migrate', SOURCE, '--root', root, '--json'])
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.items).toBe(9)
    expect(j.archived).toEqual(['A0'])
    expect(j.verify.ok).toBe(true)
    expect(exists(root, 'docs/roadmap/archive/A0/README.md')).toBe(true)
    expect(exists(root, 'docs/roadmap/archive/A0/old-slug.md')).toBe(true)
    expect(!exists(root, 'docs/roadmap/A0')).toBe(true)
    expect(exists(root, 'docs/roadmap/A1/beta.md')).toBe(true)
    expect(
      exists(root, 'docs/roadmap/A2/INTRO.md'),
      '>3 intro paragraphs go to INTRO.md',
    ).toBe(true)
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/RULES.md'), 'utf8'),
    ).toMatch(/### Change size/)
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/DEFERRED.md'), 'utf8'),
    ).toMatch(/- Another idea/)
    const index = idx(root)
    expect(index).toMatch(
      /\n## Archive\n\n- \[A0 — Done milestone\]\(roadmap\/archive\/A0\/README\.md\)\n$/,
    )
    expect(index).toMatch(
      /^- \[ \] \[feature\] \[beta\]\(roadmap\/A1\/beta\.md\) — beta title$/m,
    )
    expect(
      fs.readFileSync(
        path.join(root, 'docs/roadmap/archive/A0/README.md'),
        'utf8',
      ),
    ).toMatch(/\[old-slug\]\(old-slug\.md\)/)
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/A1/beta.md'), 'utf8'),
    ).toMatch(
      /## Scope\n\n- \[ \] nested scope\n\n- \*\*Browser check:\*\* after a blank line inside the item\nNon-indented paragraph/,
    )
    expect(index).toMatch(
      /^This index and the item files under `docs\/roadmap\/` are the single source of truth for the fixture\.$/m,
    )
    expect(index).not.toMatch(/This file is the single source/)
    assertCheck(root)
    expect(
      run(['migrate', SOURCE, '--root', root]).code,
      'refuses to overwrite without --force',
    ).toBe(2)
  })
  it('--rules-file replaces the generated RULES.md and counts How to use as rewritten', () => {
    const root = tmp()
    const j = JSON.parse(
      run(['migrate', SOURCE, '--root', root, '--rules-file', RULES, '--json'])
        .out,
    )
    expect(j.verify.ok).toBe(true)
    expect(j.verify.rewrittenLines).toBe(5) // 4 How to use lines + 1 header line
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/RULES.md'), 'utf8'),
    ).toBe(RULES_TEXT)
  })
  it('verification catches a dropped body line', () => {
    const root = migrated()
    const f = path.join(root, 'docs/roadmap/A1/beta.md')
    fs.writeFileSync(
      f,
      fs
        .readFileSync(f, 'utf8')
        .replace('Non-indented paragraph that belongs to beta.\n', ''),
    )
    const text = fs.readFileSync(SOURCE, 'utf8')
    const v = verifyMigration(parseSource(text), text, root)
    expect(v.ok).toBe(false)
    expect(
      v.missing.some((m) => m.startsWith('beta: body line not found')),
    ).toBe(true)
  })
})

describe('add', () => {
  it('--after inserts exactly one line after the anchor, same milestone, file from template', () => {
    const root = migrated()
    const before = idx(root)
    expect(
      ok(
        root,
        'add',
        'beta-overflow',
        '--tag',
        'prep',
        '--title',
        'overflow of beta',
        '--after',
        'beta',
      ),
    ).toMatch(/added beta-overflow to A1 \(after beta\)/)
    const d = lineDiff(before, idx(root))
    expect(d.removed).toEqual([])
    expect(d.added).toEqual([
      '- [ ] [prep] [beta-overflow](roadmap/A1/beta-overflow.md) — overflow of beta',
    ])
    expect(order(root).slice(0, 4)).toEqual([
      'alpha',
      'beta',
      'beta-overflow',
      'gamma',
    ])
    const f = fs.readFileSync(
      path.join(root, 'docs/roadmap/A1/beta-overflow.md'),
      'utf8',
    )
    expect(f).toBe(
      '# beta-overflow\n\nTag: prep\nMilestone: A1\nTitle: overflow of beta\n\n## Scope\n\n- [ ] TODO: scope\n- **Done when:** TODO\n',
    )
    assertCheck(root)
  })
  it('--before, --top, --bottom, cross-milestone, --body', () => {
    const root = migrated()
    ok(
      root,
      'add',
      'finding',
      '--tag',
      'prep',
      '--title',
      'review finding',
      '--before',
      'delta',
      '--body',
      '- [ ] fix it\n',
    )
    ok(
      root,
      'add',
      'first',
      '--tag',
      'feature',
      '--title',
      'f',
      '--milestone',
      'A2',
      '--top',
    )
    ok(
      root,
      'add',
      'last',
      '--tag',
      'feature',
      '--title',
      'l',
      '--milestone',
      'A2',
      '--bottom',
    )
    ok(
      root,
      'add',
      'deflt',
      '--tag',
      'feature',
      '--title',
      'd',
      '--milestone',
      'A1',
    )
    expect(order(root)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'finding',
      'delta',
      'deflt',
      'first',
      'epsilon',
      'zeta',
      'last',
    ])
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/A1/finding.md'), 'utf8'),
    ).toMatch(/## Scope\n\n- \[ \] fix it\n$/)
    expect(exists(root, 'docs/roadmap/A2/first.md')).toBe(true)
    assertCheck(root)
  })
  it('--body-file', () => {
    const root = migrated()
    const bf = path.join(root, 'body.md')
    fs.writeFileSync(bf, '  - [ ] from file\n')
    ok(
      root,
      'add',
      'bf',
      '--tag',
      'prep',
      '--title',
      't',
      '--after',
      'zeta',
      '--body-file',
      bf,
    )
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/A2/bf.md'), 'utf8'),
    ).toMatch(/  - \[ \] from file\n$/)
  })
  const rejects = [
    [['dup', 'beta', '--after', 'alpha'], /slug already exists: beta/],
    [
      ['dup-archived', 'old-slug', '--after', 'alpha'],
      /slug already exists: old-slug/,
    ],
    [['bad slug', 'Bad_Slug', '--after', 'alpha'], /bad slug/],
    [
      ['archived milestone', 'x-1', '--milestone', 'A0'],
      /milestone A0 is archived/,
    ],
    [
      ['unknown milestone', 'x-1', '--milestone', 'Z9'],
      /unknown milestone: Z9/,
    ],
    [['unknown anchor', 'x-1', '--after', 'nope'], /unknown anchor: nope/],
    [['archived anchor', 'x-1', '--before', 'old-slug'], /archived milestone/],
    [
      [
        'anchor/milestone mismatch',
        'x-1',
        '--after',
        'beta',
        '--milestone',
        'A2',
      ],
      /anchor beta is in A1, not A2/,
    ],
    [['no position', 'x-1'], /position required/],
    [
      ['top with anchor', 'x-1', '--after', 'beta', '--top'],
      /--top\/--bottom only go with --milestone/,
    ],
  ]
  for (const [[name, slug, ...pos], re] of rejects)
    it(`rejects ${name}; index and files unchanged`, () => {
      const root = migrated()
      const before = idx(root)
      const r = cli(root, 'add', slug, '--tag', 'prep', '--title', 'T', ...pos)
      expect(r.code).toBe(2)
      expect(r.err).toMatch(re)
      expect(idx(root)).toBe(before)
      expect(
        !exists(root, `docs/roadmap/A1/${slug}.md`) || slug === 'beta',
      ).toBe(true)
    })
  it('rejects bad tag and missing title', () => {
    const root = migrated()
    expect(
      cli(
        root,
        'add',
        'x-1',
        '--tag',
        'chore',
        '--title',
        'T',
        '--after',
        'beta',
      ).err,
    ).toMatch(/bad tag/)
    expect(
      cli(root, 'add', 'x-1', '--tag', 'prep', '--after', 'beta').err,
    ).toMatch(/--title required/)
  })
})

describe('done', () => {
  it('marks Status in the item file without ticking the index; double done refused', () => {
    const root = migrated()
    const before = idx(root)
    expect(ok(root, 'done', 'beta')).toBe('done beta (A1 2/4)')
    expect(idx(root)).toBe(before)
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/A1/beta.md'), 'utf8'),
    ).toMatch(/^Status: done$/m)
    const r = cli(root, 'done', 'beta')
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/already done: beta/)
    expect(cli(root, 'done', 'old-slug').err).toMatch(
      /already done \(archived\)/,
    )
    expect(cli(root, 'done', 'nope').err).toMatch(/unknown slug/)
  })
  it('last item does not archive; archive + sync move the milestone', () => {
    const root = migrated()
    ok(root, 'done', 'beta')
    ok(root, 'done', 'gamma', '--note', 'not needed (gate passed in `beta`)')
    const before = idx(root)
    const out = ok(root, 'done', 'delta')
    expect(out).toBe('done delta (A1 4/4)')
    expect(idx(root)).toBe(before)
    expect(exists(root, 'docs/roadmap/A1')).toBe(true)
    const check = cli(root, 'check')
    expect(check.code).toBe(0)
    expect(check.out).toMatch(/warning: archive: A1 is fully done/)
    expect(ok(root, 'archive', 'A1')).toMatch(
      /archived A1 -> docs\/roadmap\/archive\/A1\/README\.md/,
    )
    expect(!exists(root, 'docs/roadmap/A1')).toBe(true)
    expect(exists(root, 'docs/roadmap/archive/A1/beta.md')).toBe(true)
    expect(ok(root, 'next')).toMatch(/^slug: epsilon/)
    assertCheck(root)
  })
  it('--note is appended to the item file and printed', () => {
    const root = migrated()
    expect(
      ok(root, 'done', 'beta', '--note', 'shipped without the blank-line case'),
    ).toBe('done beta (A1 2/4)\nnote: shipped without the blank-line case')
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/A1/beta.md'), 'utf8'),
    ).toMatch(
      /Status: done\n[\s\S]*## Done note\n\nshipped without the blank-line case\n$/,
    )
    expect(ok(root, 'show', 'beta')).toMatch(/## Done note\n\nshipped without/)
    expect(JSON.parse(ok(root, 'done', 'delta', '--json')).note).toBe(null)
    assertCheck(root)
  })
  it('[contingency] needs --note; bad notes refused; index unchanged', () => {
    const root = migrated()
    const before = idx(root)
    expect(cli(root, 'done', 'gamma').err).toMatch(
      /gamma is a \[contingency\]: close it with --note/,
    )
    expect(cli(root, 'done', 'beta', '--note', '  ').err).toMatch(
      /--note must be one non-empty line/,
    )
    expect(cli(root, 'done', 'beta', '--note', 'a\nb').err).toMatch(
      /--note must be one non-empty line/,
    )
    expect(idx(root)).toBe(before)
    expect(
      ok(root, 'done', 'gamma', '--note', 'not needed (gate passed in `beta`)'),
    ).toMatch(/^done gamma \(A1 2\/4\)\nnote: not needed/)
  })
  it('archive of the last milestone at EOF keeps the trailing newline and creates ## Archive', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'docs/roadmap/M1'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'docs/roadmap.md'),
      '# R\n\n## M1 — one\n\n- [ ] [prep] [a](roadmap/M1/a.md) — a\n',
    )
    fs.writeFileSync(
      path.join(root, 'docs/roadmap/M1/a.md'),
      '# a\n\nTag: prep\nMilestone: M1\nTitle: a\n',
    )
    expect(ok(root, 'done', 'a')).toBe('done a (M1 1/1)')
    expect(idx(root)).toMatch(/- \[ \] \[prep\] \[a\]/)
    expect(ok(root, 'archive', 'M1')).toMatch(
      /archived M1 -> docs\/roadmap\/archive\/M1\/README\.md/,
    )
    expect(idx(root)).toBe(
      '# R\n\n## Archive\n\n- [M1 — one](roadmap/archive/M1/README.md)\n',
    )
    assertCheck(root)
    expect(ok(root, 'next')).toMatch(/next: none/)
  })
  it('two parallel dones leave the shared index untouched until sync', () => {
    const root = migrated()
    const before = idx(root)
    ok(root, 'done', 'beta')
    ok(root, 'done', 'epsilon')
    expect(idx(root)).toBe(before)
    const sync = ok(root, 'sync')
    expect(sync).toMatch(/synced 2 index tick/)
    expect(idx(root)).toMatch(
      /- \[x\] \[feature\] \[beta\]\(roadmap\/A1\/beta\.md\)/,
    )
    expect(idx(root)).toMatch(
      /- \[x\] \[feature\] \[epsilon\]\(roadmap\/A2\/epsilon\.md\)/,
    )
  })
  it('next --slug validates open active items', () => {
    const root = migrated()
    expect(ok(root, 'next', '--slug', 'beta')).toMatch(/^slug: beta/)
    expect(cli(root, 'next', '--slug', 'nope').err).toMatch(/unknown slug/)
    ok(root, 'done', 'beta')
    expect(cli(root, 'next', '--slug', 'beta').err).toMatch(/already done/)
    expect(cli(root, 'next', '--slug', 'gamma').err).toMatch(/contingency/)
    expect(
      ok(root, 'next', '--slug', 'gamma', '--include-contingency'),
    ).toMatch(/^slug: gamma/)
    expect(ok(root, 'claim', 'delta')).toMatch(/claimed delta/)
  })
})

describe('move', () => {
  it('within a milestone: one line moves, file stays', () => {
    const root = migrated()
    const before = idx(root)
    expect(ok(root, 'move', 'delta', '--before', 'beta')).toMatch(
      /moved delta within A1 \(before beta\)/,
    )
    expect(order(root).slice(0, 4)).toEqual(['alpha', 'delta', 'beta', 'gamma'])
    const d = lineDiff(before, idx(root))
    expect(d.added.length).toBe(1)
    expect(d.added).toEqual(d.removed)
    expect(exists(root, 'docs/roadmap/A1/delta.md')).toBe(true)
    assertCheck(root)
  })
  it('across milestones: file moved, link and Milestone field fixed; moving back restores bytes', () => {
    const root = migrated()
    const before = idx(root)
    const beforeFile = fs.readFileSync(
      path.join(root, 'docs/roadmap/A1/delta.md'),
      'utf8',
    )
    ok(root, 'move', 'delta', '--milestone', 'A2', '--top')
    expect(!exists(root, 'docs/roadmap/A1/delta.md')).toBe(true)
    const f = fs.readFileSync(
      path.join(root, 'docs/roadmap/A2/delta.md'),
      'utf8',
    )
    expect(f).toMatch(/^Milestone: A2$/m)
    expect(idx(root)).toMatch(
      /^- \[ \] \[prep\] \[delta\]\(roadmap\/A2\/delta\.md\) — delta — with a dash in title\n- \[ \] \[feature\] \[epsilon\]/m,
    )
    assertCheck(root)
    ok(root, 'move', 'delta', '--after', 'gamma')
    expect(idx(root)).toBe(before)
    expect(
      fs.readFileSync(path.join(root, 'docs/roadmap/A1/delta.md'), 'utf8'),
    ).toBe(beforeFile)
  })
  it('refusals leave the index unchanged', () => {
    const root = migrated()
    const before = idx(root)
    expect(cli(root, 'move', 'beta', '--after', 'beta').err).toMatch(
      /relative to itself/,
    )
    expect(cli(root, 'move', 'nope', '--after', 'beta').err).toMatch(
      /unknown slug/,
    )
    expect(cli(root, 'move', 'beta', '--milestone', 'A0').err).toMatch(
      /archived/,
    )
    ok(root, 'move', 'beta', '--milestone', 'A2')
    ok(root, 'move', 'gamma', '--milestone', 'A2')
    const mid = idx(root)
    expect(cli(root, 'move', 'delta', '--milestone', 'A2').err).toMatch(
      /would leave A1 with no open items/,
    )
    expect(idx(root)).toBe(mid)
    expect(mid).not.toBe(before)
  })
})

describe('check (one failing fixture per rule)', () => {
  const cases = [
    [
      'missing item file',
      (r) => fs.rmSync(path.join(r, 'docs/roadmap/A1/beta.md')),
      /^file: .*beta: missing file/,
    ],
    [
      'link mismatch',
      (r) =>
        edit(
          r,
          'docs/roadmap.md',
          '](roadmap/A1/beta.md)',
          '](roadmap/A2/beta.md)',
        ),
      /^link: .*beta links roadmap\/A2\/beta\.md/,
    ],
    [
      'file without index line',
      (r) =>
        fs.writeFileSync(path.join(r, 'docs/roadmap/A1/stray.md'), '# stray\n'),
      /^orphan: docs\/roadmap\/A1\/stray\.md has 0 index lines/,
    ],
    [
      'orphan folder',
      (r) => fs.mkdirSync(path.join(r, 'docs/roadmap/Z9')),
      /^orphan: docs\/roadmap\/Z9\//,
    ],
    [
      'duplicate slug in index',
      (r) =>
        edit(
          r,
          'docs/roadmap.md',
          '- [ ] [prep] [zeta]',
          '- [ ] [prep] [zeta](roadmap/A2/zeta.md) — dup\n- [ ] [prep] [zeta]',
        ),
      /^unique: .*duplicate slug zeta/,
    ],
    [
      'slug active and archived',
      (r) =>
        fs.copyFileSync(
          path.join(r, 'docs/roadmap/A1/beta.md'),
          path.join(r, 'docs/roadmap/archive/A0/beta.md'),
        ),
      /^unique: beta is both active/,
    ],
    [
      'nested line in index',
      (r) =>
        edit(
          r,
          'docs/roadmap.md',
          '— beta title\n',
          '— beta title\n  - [ ] nested\n',
        ),
      /^single-line: .*indented/,
    ],
    [
      'archive line without folder',
      (r) =>
        fs.renameSync(
          path.join(r, 'docs/roadmap/archive/A0'),
          path.join(r, 'docs/gone'),
        ),
      /^archive: .*missing folder docs\/roadmap\/archive\/A0\//,
    ],
    [
      'archive folder without README',
      (r) => fs.rmSync(path.join(r, 'docs/roadmap/archive/A0/README.md')),
      /^archive: missing docs\/roadmap\/archive\/A0\/README\.md/,
    ],
    [
      'archive folder without archive line',
      (r) => fs.mkdirSync(path.join(r, 'docs/roadmap/archive/A9')),
      /^archive: docs\/roadmap\/archive\/A9\/ has 0 archive lines/,
    ],
    [
      'duplicate archive line',
      (r) =>
        edit(
          r,
          'docs/roadmap.md',
          '- [A0 — Done milestone](roadmap/archive/A0/README.md)',
          '- [A0 — Done milestone](roadmap/archive/A0/README.md)\n- [A0 — Done milestone](roadmap/archive/A0/README.md)',
        ),
      /has 2 archive lines/,
    ],
    [
      'heading mismatch',
      (r) => edit(r, 'docs/roadmap/A1/beta.md', '# beta\n', '# betaa\n'),
      /^heading: .*"# betaa" does not match slug beta/,
    ],
    [
      'tag differs from item file',
      (r) => edit(r, 'docs/roadmap/A1/beta.md', 'Tag: feature', 'Tag: prep'),
      /^meta: docs\/roadmap\/A1\/beta\.md: Tag "prep" but index has feature/,
    ],
    [
      'title differs from item file',
      (r) => edit(r, 'docs/roadmap.md', '— beta title', '— beta title changed'),
      /^meta: docs\/roadmap\/A1\/beta\.md: Title differs from index line/,
    ],
    [
      'archived heading mismatch',
      (r) =>
        edit(r, 'docs/roadmap/archive/A0/old-slug.md', '# old-slug', '# other'),
      /^heading: docs\/roadmap\/archive\/A0\/old-slug\.md/,
    ],
  ]
  function edit(root, p, a, b) {
    const f = path.join(root, p)
    const t = fs.readFileSync(f, 'utf8')
    expect(t.includes(a), `fixture edit: ${a}`).toBe(true)
    fs.writeFileSync(f, t.replace(a, b))
  }
  it('clean migration passes (exit 0)', () => {
    const root = migrated()
    expect(cli(root, 'check').code).toBe(0)
  })
  it('fully done milestone left active is a warning, not a failure', () => {
    const root = migrated()
    for (const s of ['beta', 'gamma', 'delta']) {
      const tag =
        s === 'beta' ? 'feature' : s === 'gamma' ? 'contingency' : 'prep'
      edit(
        root,
        'docs/roadmap.md',
        `- [ ] [${tag}] [${s}]`,
        `- [x] [${tag}] [${s}]`,
      )
    }
    const r = cli(root, 'check')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/warning: archive: A1 is fully done but still active/)
  })
  for (const [name, mutate, re] of cases)
    it(name, () => {
      const root = migrated()
      mutate(root)
      const r = cli(root, 'check')
      expect(r.code, r.out).toBe(1)
      const errs = r.out.split('\n')
      expect(
        errs.some((l) => re.test(l)),
        `expected ${re} in:\n${r.out}`,
      ).toBe(true)
      expect(errs.at(-1)).toMatch(/^check failed: \d+ error/)
    })
})

describe('next / show / list / cli', () => {
  it('next skips contingency and --skip; --include-contingency; --no-body', () => {
    const root = migrated()
    expect(ok(root, 'next')).toMatch(
      /^slug: beta\ntag: feature\nstatus: open\nmilestone: A1 — First\ngoal: \*\*Review cut:\*\* first goal\.\ngoal: \*\*Order:\*\* second paragraph\.\ntitle: beta title\nfile: docs\/roadmap\/A1\/beta\.md\n---\n## Scope\n\n- \[ \] nested scope/,
    )
    expect(ok(root, 'next', '--skip', 'beta')).toMatch(/^slug: delta/)
    expect(ok(root, 'next', '--skip', 'beta', '--include-contingency')).toMatch(
      /^slug: gamma/,
    )
    expect(ok(root, 'next', '--no-body')).not.toMatch(/---/)
    const j = JSON.parse(ok(root, 'next', '--json'))
    expect(j.slug).toBe('beta')
    expect(j.body).toMatch(/Non-indented paragraph/)
  })
  it('next shows INTRO.md pointer as a docs/ path', () => {
    const root = migrated()
    expect(ok(root, 'show', 'epsilon')).toMatch(
      /goal: Notes: \[INTRO\.md\]\(docs\/roadmap\/A2\/INTRO\.md\)/,
    )
  })
  it('show archived item; list', () => {
    const root = migrated()
    expect(ok(root, 'show', 'old-slug')).toMatch(
      /status: done \(archived\)\nmilestone: A0/,
    )
    expect(ok(root, 'list', '--open', '--milestone', 'A2')).toBe(
      'A2 — Second (0/2 done)\n[ ] epsilon (feature) — epsilon title\n[ ] zeta (prep) — zeta title',
    )
    expect(ok(root, 'list')).toMatch(/archived: A0$/)
  })
  it('usage errors', () => {
    const root = migrated()
    expect(cli(root, 'frobnicate').err).toMatch(/unknown command/)
    expect(cli(root, 'next', '--bogus').err).toMatch(/unknown option --bogus/)
    expect(run(['next', '--root', tmp()]).err).toMatch(/index not found/)
  })
  it('real process: exit codes and stdout', () => {
    const root = migrated()
    expect(
      execFileSync(process.execPath, [CLI, 'check', '--root', root], {
        encoding: 'utf8',
      }),
    ).toMatch(/^OK roadmap \(/)
    expect(
      execFileSync(process.execPath, [CLI, 'check', '--root', root], {
        encoding: 'utf8',
        env: { ...process.env, PHOTOBOOKS_CHECK_INNER: '1' },
      }),
    ).toMatch(/^check ok/)
    fs.rmSync(path.join(root, 'docs/roadmap/A1/beta.md'))
    let status = 0
    let failOut = ''
    try {
      execFileSync(process.execPath, [CLI, 'check', '--root', root], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (e) {
      status = e.status
      failOut = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
    expect(status).not.toBe(0)
    expect(failOut).toMatch(/roadmap:.*beta/)
  })

  it('checkWrapperArgs wraps check unless already inner', () => {
    expect(checkWrapperArgs(['next'], {})).toBe(null)
    expect(checkWrapperArgs(['check'], { PHOTOBOOKS_CHECK_INNER: '1' })).toBe(
      null,
    )
    const wrap = checkWrapperArgs(
      ['check', '--root', '/tmp'],
      {},
      {
        selfPath: CLI,
        execPath: '/node',
      },
    )
    expect(wrap).not.toBe(null)
    expect(wrap.file).toBe('/node')
    expect(wrap.args).toEqual([
      path.join(here, 'check.mjs'),
      '--run',
      'roadmap',
      '--',
      '/node',
      CLI,
      'check',
      '--root',
      '/tmp',
    ])
    expect(wrap.env.PHOTOBOOKS_CHECK_INNER).toBe('1')

    const viaFlag = checkWrapperArgs(
      ['check', '-v', '--root', '/tmp'],
      {},
      { selfPath: CLI, execPath: '/node' },
    )
    expect(viaFlag.args[1]).toBe('--verbose')
    expect(viaFlag.args).not.toContain('-v')
    expect(viaFlag.args).toContain('--root')

    const viaEnv = checkWrapperArgs(
      ['check', '--root', '/tmp'],
      { CHECK_VERBOSE: '1' },
      { selfPath: CLI, execPath: '/node' },
    )
    expect(viaEnv.args[1]).toBe('--verbose')
  })

  it('execCheckWrapper / bootRoadmapCli cover wrap and entry paths', () => {
    let exitCode = null
    /** @type {{ file: string, args: string[], opts: object } | null} */
    let spawned = null
    execCheckWrapper(
      { file: '/node', args: ['a'], env: { PHOTOBOOKS_CHECK_INNER: '1' } },
      {
        spawnSync: (file, args, opts) => {
          spawned = { file, args, opts }
          return { status: 0 }
        },
        exit: (c) => {
          exitCode = c
        },
      },
    )
    expect(spawned.file).toBe('/node')
    expect(spawned.opts.env.PHOTOBOOKS_CHECK_INNER).toBe('1')
    expect(exitCode).toBe(0)

    exitCode = null
    execCheckWrapper(
      { file: '/node', args: [], env: {} },
      {
        spawnSync: () => ({ status: null }),
        exit: (c) => {
          exitCode = c
        },
      },
    )
    expect(exitCode).toBe(1)

    const prevExit = process.exit
    exitCode = null
    process.exit = /** @type {typeof process.exit} */ (
      (c) => {
        exitCode = c
      }
    )
    try {
      execCheckWrapper(
        { file: '/node', args: [], env: {} },
        { spawnSync: () => ({ status: 9 }) },
      )
    } finally {
      process.exit = prevExit
    }
    expect(exitCode).toBe(9)

    expect(bootRoadmapCli('', ['check'], {})).toBe(false)
    expect(bootRoadmapCli(null, ['check'], {})).toBe(false)
    expect(bootRoadmapCli('/other.mjs', ['check'], {})).toBe(false)

    exitCode = null
    spawned = null
    expect(
      bootRoadmapCli(
        CLI,
        ['check', '--root', '/tmp'],
        {},
        {
          metaUrl: `file://${CLI}`,
          spawnSync: (file, args, opts) => {
            spawned = { file, args, opts }
            return { status: 4 }
          },
          exit: (c) => {
            exitCode = c
          },
        },
      ),
    ).toBe(true)
    expect(spawned.args).toContain('--run')
    expect(exitCode).toBe(4)

    let mainCalled = false
    expect(
      bootRoadmapCli(
        CLI,
        ['check', '--root', '/tmp'],
        { PHOTOBOOKS_CHECK_INNER: '1' },
        {
          metaUrl: `file://${CLI}`,
          mainFn: (argv) => {
            mainCalled = true
            expect(argv[0]).toBe('check')
          },
          io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
        },
      ),
    ).toBe(true)
    expect(mainCalled).toBe(true)

    // Default argv/env from process when omitted (undefined → process defaults).
    expect(
      bootRoadmapCli(CLI, undefined, undefined, {
        metaUrl: `file://${CLI}`,
        mainFn: () => {},
        io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
      }),
    ).toBe(true)
  })
  it('writes are atomic (no temp files left)', () => {
    const root = migrated()
    ok(root, 'add', 'x-1', '--tag', 'prep', '--title', 'T', '--after', 'beta')
    ok(root, 'done', 'x-1')
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [e.name],
        )
    expect(walk(root).filter((n) => n.includes('.tmp-'))).toEqual([])
  })
})

describe('repository roadmap', () => {
  it('docs/roadmap.md and docs/roadmap/** pass check', () => {
    const r = cmdCheck(load(REPO))
    expect(r.errors).toEqual([])
    expect(r.items).toBeGreaterThan(0)
  })
})

describe('exact outputs', () => {
  const tree = (root) => {
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory()
            ? walk(path.join(d, e.name))
            : [path.relative(root, path.join(d, e.name))],
        )
    return walk(path.join(root, 'docs')).sort()
  }
  const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8')

  it('migrate: report, tree and generated files', () => {
    const root = tmp()
    expect(run(['migrate', SOURCE, '--root', root]).out).toMatchInlineSnapshot(`
      "migrated 9 items (4 done, 5 open) in 3 milestones; 13 files
      archived: A0
      generated slugs: tooling-ci-and-things, tooling-ci-and-things-2
      index: 1160 bytes
      verify: ok (9 items, 8 body lines, 21 other lines, 1 rewritten by owner decision)"
    `)
    expect(tree(root)).toMatchInlineSnapshot(`
      [
        "docs/roadmap.md",
        "docs/roadmap/A1/alpha.md",
        "docs/roadmap/A1/beta.md",
        "docs/roadmap/A1/delta.md",
        "docs/roadmap/A1/gamma.md",
        "docs/roadmap/A2/INTRO.md",
        "docs/roadmap/A2/epsilon.md",
        "docs/roadmap/A2/zeta.md",
        "docs/roadmap/DEFERRED.md",
        "docs/roadmap/RULES.md",
        "docs/roadmap/archive/A0/README.md",
        "docs/roadmap/archive/A0/old-slug.md",
        "docs/roadmap/archive/A0/tooling-ci-and-things-2.md",
        "docs/roadmap/archive/A0/tooling-ci-and-things.md",
      ]
    `)
    expect(idx(root)).toMatchInlineSnapshot(`
      "# Roadmap

      Header paragraph.

      This index and the item files under \`docs/roadmap/\` are the single source of truth for the fixture.

      Process: [roadmap/RULES.md](roadmap/RULES.md). One file per item: \`roadmap/<milestone>/<slug>.md\`; finished milestones: \`roadmap/archive/\`. Change the index only with \`pnpm roadmap\` (\`add\` / \`done\` / \`move\`), never by hand.

      ## Order

      1. A then B.

      ## A1 — First

      **Review cut:** first goal.

      **Order:** second paragraph.

      - [x] [prep] [alpha](roadmap/A1/alpha.md) — alpha title (Security Review: x)
      - [ ] [feature] [beta](roadmap/A1/beta.md) — beta title
      - [ ] [contingency] [gamma](roadmap/A1/gamma.md) — only if beta fails
      - [ ] [prep] [delta](roadmap/A1/delta.md) — delta — with a dash in title

      ## A2 — Second

      **Review cut:** one.

      Notes: [INTRO.md](roadmap/A2/INTRO.md)

      - [ ] [feature] [epsilon](roadmap/A2/epsilon.md) — epsilon title
      - [ ] [prep] [zeta](roadmap/A2/zeta.md) — zeta title

      ## Deferred (not scheduled)

      Not scheduled, not items: [roadmap/DEFERRED.md](roadmap/DEFERRED.md). To schedule one, the owner asks for an \`add\`.

      ## Archive

      - [A0 — Done milestone](roadmap/archive/A0/README.md)
      "
    `)
    expect(read(root, 'docs/roadmap/archive/A0/README.md'))
      .toMatchInlineSnapshot(`
      "## A0 — Done milestone

      - [x] [tooling-ci-and-things](tooling-ci-and-things.md) — Tooling, CI and things
      - [x] [old-slug](old-slug.md) — uppercase done, no tag
      - [x] [tooling-ci-and-things-2](tooling-ci-and-things-2.md) — Tooling, CI and things
      "
    `)
    expect(read(root, 'docs/roadmap/A2/INTRO.md')).toMatchInlineSnapshot(`
      "# A2 — notes

      **Two:** two.

      **Three:** three.

      **Four:** four.
      "
    `)
    expect(read(root, 'docs/roadmap/DEFERRED.md')).toMatchInlineSnapshot(`
      "# Deferred (not scheduled)

      - Some idea
      - Another idea
      "
    `)
    expect(read(root, 'docs/roadmap/RULES.md')).toMatchInlineSnapshot(`
      "# Roadmap rules

      ## How to use

      - Each top-level checkbox is one change.

      ### Change size

      Grow in place.
      "
    `)
    expect(read(root, 'docs/roadmap/A1/delta.md')).toMatchInlineSnapshot(`
      "# delta

      Tag: prep
      Milestone: A1
      Title: delta — with a dash in title

      ## Scope

      ### Sub heading inside delta
      - [ ] still delta
      "
    `)
    expect(read(root, 'docs/roadmap/archive/A0/tooling-ci-and-things.md'))
      .toMatchInlineSnapshot(`
      "# tooling-ci-and-things

      Tag: none
      Milestone: A0
      Title: Tooling, CI and things
      "
    `)
  })

  it('next / show / list / check text and json', () => {
    const root = migrated()
    expect(ok(root, 'next')).toMatchInlineSnapshot(`
      "slug: beta
      tag: feature
      status: open
      milestone: A1 — First
      goal: **Review cut:** first goal.
      goal: **Order:** second paragraph.
      title: beta title
      file: docs/roadmap/A1/beta.md
      ---
      ## Scope

      - [ ] nested scope

      - **Browser check:** after a blank line inside the item
      Non-indented paragraph that belongs to beta."
    `)
    expect(ok(root, 'show', 'epsilon', '--no-body')).toMatchInlineSnapshot(`
      "slug: epsilon
      tag: feature
      status: open
      milestone: A2 — Second
      goal: **Review cut:** one.
      goal: Notes: [INTRO.md](docs/roadmap/A2/INTRO.md)
      title: epsilon title
      file: docs/roadmap/A2/epsilon.md"
    `)
    expect(ok(root, 'show', 'old-slug')).toMatchInlineSnapshot(`
      "slug: old-slug
      tag: none
      status: done (archived)
      milestone: A0
      title: uppercase done, no tag
      file: docs/roadmap/archive/A0/old-slug.md
      ---
      "
    `)
    expect(JSON.parse(ok(root, 'show', 'old-slug', '--json')))
      .toMatchInlineSnapshot(`
      {
        "body": "",
        "file": "docs/roadmap/archive/A0/old-slug.md",
        "goal": [],
        "milestone": "A0",
        "milestoneTitle": null,
        "slug": "old-slug",
        "status": "done (archived)",
        "tag": null,
        "title": "uppercase done, no tag",
      }
    `)
    expect(ok(root, 'list')).toMatchInlineSnapshot(`
      "A1 — First (1/4 done)
      [x] alpha (prep) — alpha title (Security Review: x)
      [ ] beta (feature) — beta title
      [ ] gamma (contingency) — only if beta fails
      [ ] delta (prep) — delta — with a dash in title
      A2 — Second (0/2 done)
      [ ] epsilon (feature) — epsilon title
      [ ] zeta (prep) — zeta title
      archived: A0"
    `)
    expect(JSON.parse(ok(root, 'list', '--open', '--json')))
      .toMatchInlineSnapshot(`
      {
        "archived": [
          "A0",
        ],
        "milestones": [
          {
            "done": 1,
            "id": "A1",
            "items": [
              {
                "done": false,
                "slug": "beta",
                "tag": "feature",
                "title": "beta title",
              },
              {
                "done": false,
                "slug": "gamma",
                "tag": "contingency",
                "title": "only if beta fails",
              },
              {
                "done": false,
                "slug": "delta",
                "tag": "prep",
                "title": "delta — with a dash in title",
              },
            ],
            "title": "First",
            "total": 4,
          },
          {
            "done": 0,
            "id": "A2",
            "items": [
              {
                "done": false,
                "slug": "epsilon",
                "tag": "feature",
                "title": "epsilon title",
              },
              {
                "done": false,
                "slug": "zeta",
                "tag": "prep",
                "title": "zeta title",
              },
            ],
            "title": "Second",
            "total": 2,
          },
        ],
      }
    `)
    expect(ok(root, 'check')).toMatchInlineSnapshot(
      `"check ok: 6 items (5 open), 2 active milestones, 1 archived"`,
    )
    expect(JSON.parse(ok(root, 'next', '--json', '--no-body')))
      .toMatchInlineSnapshot(`
      {
        "file": "docs/roadmap/A1/beta.md",
        "goal": [
          "**Review cut:** first goal.",
          "**Order:** second paragraph.",
        ],
        "milestone": "A1",
        "milestoneTitle": "First",
        "slug": "beta",
        "status": "open",
        "tag": "feature",
        "title": "beta title",
      }
    `)
  })

  it('add / move / done text and json', () => {
    const root = migrated()
    expect(
      ok(
        root,
        'add',
        'n-1',
        '--tag',
        'feature',
        '--title',
        'N one',
        '--milestone',
        'A2',
        '--top',
      ),
    ).toMatchInlineSnapshot(
      `"added n-1 to A2 (A2 top); file docs/roadmap/A2/n-1.md"`,
    )
    expect(
      JSON.parse(
        ok(
          root,
          'add',
          'n-2',
          '--tag',
          'contingency',
          '--title',
          'N two',
          '--before',
          'zeta',
          '--json',
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "added": "n-2",
        "file": "docs/roadmap/A2/n-2.md",
        "milestone": "A2",
        "position": "before zeta",
      }
    `)
    expect(read(root, 'docs/roadmap/A2/n-1.md')).toMatchInlineSnapshot(`
      "# n-1

      Tag: feature
      Milestone: A2
      Title: N one

      ## Scope

      - [ ] TODO: scope
      - **Browser check:** TODO
      "
    `)
    expect(read(root, 'docs/roadmap/A2/n-2.md')).toMatchInlineSnapshot(`
      "# n-2

      Tag: contingency
      Milestone: A2
      Title: N two

      ## Scope

      - [ ] TODO: scope
      "
    `)
    expect(
      ok(root, 'move', 'n-1', '--milestone', 'A1', '--bottom'),
    ).toMatchInlineSnapshot(
      `"moved n-1 A2 -> A1 (A1 bottom); file docs/roadmap/A1/n-1.md"`,
    )
    expect(JSON.parse(ok(root, 'move', 'n-1', '--after', 'epsilon', '--json')))
      .toMatchInlineSnapshot(`
      {
        "file": "docs/roadmap/A2/n-1.md",
        "from": "A1",
        "moved": "n-1",
        "position": "after epsilon",
        "to": "A2",
      }
    `)
    expect(JSON.parse(ok(root, 'done', 'beta', '--json')))
      .toMatchInlineSnapshot(`
        {
          "archived": null,
          "done": "beta",
          "indexTicked": false,
          "milestone": "A1",
          "note": null,
          "progress": "2/4",
        }
      `)
    expect(idx(root)).toMatchInlineSnapshot(`
      "# Roadmap

      Header paragraph.

      This index and the item files under \`docs/roadmap/\` are the single source of truth for the fixture.

      Process: [roadmap/RULES.md](roadmap/RULES.md). One file per item: \`roadmap/<milestone>/<slug>.md\`; finished milestones: \`roadmap/archive/\`. Change the index only with \`pnpm roadmap\` (\`add\` / \`done\` / \`move\`), never by hand.

      ## Order

      1. A then B.

      ## A1 — First

      **Review cut:** first goal.

      **Order:** second paragraph.

      - [x] [prep] [alpha](roadmap/A1/alpha.md) — alpha title (Security Review: x)
      - [ ] [feature] [beta](roadmap/A1/beta.md) — beta title
      - [ ] [contingency] [gamma](roadmap/A1/gamma.md) — only if beta fails
      - [ ] [prep] [delta](roadmap/A1/delta.md) — delta — with a dash in title

      ## A2 — Second

      **Review cut:** one.

      Notes: [INTRO.md](roadmap/A2/INTRO.md)

      - [ ] [feature] [epsilon](roadmap/A2/epsilon.md) — epsilon title
      - [ ] [feature] [n-1](roadmap/A2/n-1.md) — N one
      - [ ] [contingency] [n-2](roadmap/A2/n-2.md) — N two
      - [ ] [prep] [zeta](roadmap/A2/zeta.md) — zeta title

      ## Deferred (not scheduled)

      Not scheduled, not items: [roadmap/DEFERRED.md](roadmap/DEFERRED.md). To schedule one, the owner asks for an \`add\`.

      ## Archive

      - [A0 — Done milestone](roadmap/archive/A0/README.md)
      "
    `)
  })

  it('help, usage and argument errors', () => {
    const root = migrated()
    expect(run(['help']).code).toBe(0)
    expect(run([]).code).toBe(2)
    expect(run(['help']).out).toMatchInlineSnapshot(`
      "usage: pnpm roadmap <cmd> [--root <repo>] [--json]   (= node scripts/roadmap.mjs)
        next [--slug S] [--skip a,b] [--include-contingency] [--no-body]   current item (first open, or explicit slug)
        show <slug> [--no-body]                                 one item
        list [--milestone M] [--open]                           one line per item
        claim <slug> [--include-contingency]                    validate open slug for preflight hold
        add <slug> --tag prep|feature|contingency --title "..." (--after S | --before S | --milestone M [--top|--bottom]) [--body "..." | --body-file F]
        done <slug> [--note "..."]                              mark Status: done in the item file (no index tick; required note for [contingency])
        sync                                                    tick index [x] from item-file Status: done (post-merge)
        archive <M>                                             archive a fully-done milestone (post-merge)
        move <slug> (--after S | --before S | --milestone M [--top|--bottom])
        check                                                   consistency (exit 1 on errors; warnings for pending sync/archive)
        migrate <source.md> [--rules-file RULES.md] [--force]   one-off conversion into <root>/docs/"
    `)
    const errs = [
      ['show'],
      ['add'],
      ['done'],
      ['move'],
      ['migrate'],
      ['next', 'extra', 'more'],
      ['next', '--root'],
      [
        'add',
        'x-1',
        '--tag=prep',
        '--title=T',
        '--after',
        'beta',
        '--before',
        'gamma',
      ],
      [
        'add',
        'x-1',
        '--tag',
        'prep',
        '--title',
        'T',
        '--milestone',
        'A1',
        '--top',
        '--bottom',
      ],
      ['add', 'x-1', '--tag', 'prep', '--title', 'a\nb', '--after', 'beta'],
      [
        'add',
        'x-1',
        '--tag',
        'prep',
        '--title',
        'T',
        '--after',
        'beta',
        '--body',
        'a',
        '--body-file',
        'f',
      ],
      ['show', 'nope'],
      ['move', 'old-slug', '--after', 'beta'],
      ['next', '--json', '--bogus'],
    ].map((a) => {
      const r = cli(root, ...a)
      return `${String(r.code)} ${r.err ?? ''}`
    })
    expect(errs).toMatchInlineSnapshot(`
      [
        "2 error: usage: show <slug>",
        "2 error: usage: add <slug> --tag <t> --title "..." (--after <slug> | --before <slug> | --milestone <M> [--top|--bottom])",
        "2 error: usage: done <slug> [--note "..."]",
        "2 error: usage: move <slug> (--after <slug> | --before <slug> | --milestone <M> [--top|--bottom])",
        "2 error: usage: migrate <source.md>",
        "2 error: unexpected argument: more",
        "2 error: --root needs a value (use --root=<value> for values starting with --)",
        "2 error: use only one of --after / --before",
        "2 error: use only one of --top / --bottom",
        "2 error: title must be a single line",
        "2 error: use only one of --body / --body-file",
        "2 error: unknown slug: nope",
        "2 error: slug old-slug is in an archived milestone",
        "2 error: unknown option --bogus",
      ]
    `)
    expect(cli(root, 'show', 'nope', '--json').err).toBe(
      '{"error":"unknown slug: nope"}',
    )
  })

  it('check reports every error and the count', () => {
    const root = migrated()
    fs.rmSync(path.join(root, 'docs/roadmap/A1/beta.md'))
    fs.writeFileSync(path.join(root, 'docs/roadmap/A2/stray.md'), '# stray\n')
    const r = cli(root, 'check')
    expect(r.out).toMatchInlineSnapshot(`
      "file: docs/roadmap.md:20: beta: missing file docs/roadmap/A1/beta.md
      orphan: docs/roadmap/A2/stray.md has 0 index lines (expected 1)
      check failed: 2 error(s)"
    `)
    expect(JSON.parse(cli(root, 'check', '--json').out)).toMatchInlineSnapshot(`
      {
        "archived": 1,
        "errors": [
          "file: docs/roadmap.md:20: beta: missing file docs/roadmap/A1/beta.md",
          "orphan: docs/roadmap/A2/stray.md has 0 index lines (expected 1)",
        ],
        "items": 6,
        "milestones": 2,
        "ok": false,
        "open": 5,
        "warnings": [],
      }
    `)
  })
})

describe('edge cases', () => {
  const edit = (root, p, a, b) => {
    const f = path.join(root, p)
    const t = fs.readFileSync(f, 'utf8')
    expect(t.includes(a), `fixture edit: ${a}`).toBe(true)
    fs.writeFileSync(f, t.replace(a, b))
  }
  const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8')
  const errors = (root) => cmdCheck(load(root)).errors
  const err = (root, ...a) => cli(root, ...a).err

  const LONG = 'L'.repeat(90)
  const SOURCE2_TEXT = `# R2

${LONG} header line.
  

## How to use

- [ ] example checkbox in rules

## Notes on how to use

Kept.

## How to use more

Also kept.

## Not deferred

Kept too.

## B1 — Three paragraphs

One.
   

Two.

Three.

- [ ] [prep] \`tooling-ci-and-things\` — explicit slug
  - [ ] see "Change size" in this file
  - [ ] tail with spaces
  
- [ ] Tooling, CI and things
- [ ] Tooling, CI and things
- [ ] Tooling, CI and things
- [ ] \`only-slug\`
- [ ] !!!


`
  const SOURCE2 = path.join(fixtureDir, 'source2.md')
  fs.writeFileSync(SOURCE2, SOURCE2_TEXT)

  it('migrate: rules-like and deferred-like headings, 3-paragraph intro, slug collisions, body rewrite', () => {
    const root = tmp()
    const r = cli(root, 'migrate', SOURCE2)
    expect(r.out).toMatchInlineSnapshot(`
      "migrated 6 items (0 done, 6 open) in 1 milestones; 7 files
      archived: none
      generated slugs: tooling-ci-and-things-2, tooling-ci-and-things-3, tooling-ci-and-things-4, item
      index: 962 bytes
      verify: ok (6 items, 2 body lines, 13 other lines, 1 rewritten by owner decision)"
    `)
    expect(read(root, 'docs/roadmap.md')).toMatchInlineSnapshot(`
      "# R2

      LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL header line.
        

      Process: [roadmap/RULES.md](roadmap/RULES.md). One file per item: \`roadmap/<milestone>/<slug>.md\`; finished milestones: \`roadmap/archive/\`. Change the index only with \`pnpm roadmap\` (\`add\` / \`done\` / \`move\`), never by hand.

      ## Notes on how to use

      Kept.

      ## How to use more

      Also kept.

      ## Not deferred

      Kept too.

      ## B1 — Three paragraphs

      One.

      Two.

      Three.

      - [ ] [prep] [tooling-ci-and-things](roadmap/B1/tooling-ci-and-things.md) — explicit slug
      - [ ] [tooling-ci-and-things-2](roadmap/B1/tooling-ci-and-things-2.md) — Tooling, CI and things
      - [ ] [tooling-ci-and-things-3](roadmap/B1/tooling-ci-and-things-3.md) — Tooling, CI and things
      - [ ] [tooling-ci-and-things-4](roadmap/B1/tooling-ci-and-things-4.md) — Tooling, CI and things
      - [ ] [only-slug](roadmap/B1/only-slug.md) — only-slug
      - [ ] [item](roadmap/B1/item.md) — !!!
      "
    `)
    expect(read(root, 'docs/roadmap/B1/tooling-ci-and-things.md')).toBe(
      '# tooling-ci-and-things\n\nTag: prep\nMilestone: B1\nTitle: explicit slug\n\n## Scope\n\n- [ ] see "Change size" in the roadmap rules (`docs/roadmap/RULES.md`)\n- [ ] tail with spaces\n',
    )
    expect(read(root, 'docs/roadmap/RULES.md')).toBe(
      '# Roadmap rules\n\n## How to use\n\n- [ ] example checkbox in rules\n',
    )
    expect(read(root, 'docs/roadmap/B1/item.md')).toBe(
      '# item\n\nTag: none\nMilestone: B1\nTitle: !!!\n',
    )
    expect(JSON.parse(cli(root, 'migrate', SOURCE2, '--force', '--json').out))
      .toMatchInlineSnapshot(`
        {
          "archived": [],
          "done": 0,
          "filesWritten": 7,
          "generatedSlugs": [
            "tooling-ci-and-things-2",
            "tooling-ci-and-things-3",
            "tooling-ci-and-things-4",
            "item",
          ],
          "indexBytes": 962,
          "items": 6,
          "milestones": 1,
          "open": 6,
          "verify": {
            "bodyLines": 2,
            "itemsChecked": 6,
            "missing": [],
            "ok": true,
            "otherLines": 13,
            "rewrittenLines": 1,
          },
        }
      `)
  })

  it('migrate refuses an existing index without --force; --force starts clean', () => {
    const root = tmp()
    expect(cli(root, 'migrate', SOURCE2).code).toBe(0)
    fs.writeFileSync(path.join(root, 'docs/roadmap/B1/stale.md'), '# stale\n')
    expect(err(root, 'migrate', SOURCE2)).toBe(
      `error: docs/roadmap.md exists in ${root} (use --force to overwrite)`,
    )
    expect(cli(root, 'migrate', SOURCE2, '--force').code).toBe(0)
    expect(exists(root, 'docs/roadmap/B1/stale.md')).toBe(false)
    expect(errors(root)).toEqual([])
  })

  it('migrate fixture: item bodies end where the next item starts', () => {
    const root = migrated()
    expect(read(root, 'docs/roadmap/A1/beta.md')).toBe(
      '# beta\n\nTag: feature\nMilestone: A1\nTitle: beta title\n\n## Scope\n\n- [ ] nested scope\n\n- **Browser check:** after a blank line inside the item\nNon-indented paragraph that belongs to beta.\n',
    )
    expect(read(root, 'docs/roadmap/A2/zeta.md')).toBe(
      '# zeta\n\nTag: prep\nMilestone: A2\nTitle: zeta title\n',
    )
  })

  describe('verifyMigration reports each kind of loss', () => {
    const cases = [
      [
        'active item file deleted',
        (r) => fs.rmSync(path.join(r, 'docs/roadmap/A1/beta.md')),
        ['beta: no item file'],
      ],
      [
        'archived item file deleted',
        (r) => fs.rmSync(path.join(r, 'docs/roadmap/archive/A0/old-slug.md')),
        ['old-slug: no item file'],
      ],
      [
        'heading',
        (r) => edit(r, 'docs/roadmap/A1/beta.md', '# beta\n', '# betaa\n'),
        ['beta: metadata mismatch'],
      ],
      [
        'title in file',
        (r) =>
          edit(
            r,
            'docs/roadmap/A1/beta.md',
            'Title: beta title',
            'Title: other',
          ),
        ['beta: metadata mismatch'],
      ],
      [
        'tag in file',
        (r) => edit(r, 'docs/roadmap/A1/beta.md', 'Tag: feature', 'Tag: prep'),
        ['beta: metadata mismatch'],
      ],
      [
        'milestone in file',
        (r) =>
          edit(r, 'docs/roadmap/A1/beta.md', 'Milestone: A1', 'Milestone: A2'),
        ['beta: metadata mismatch'],
      ],
      [
        'done in index',
        (r) =>
          edit(
            r,
            'docs/roadmap.md',
            '- [ ] [feature] [beta]',
            '- [x] [feature] [beta]',
          ),
        ['beta: index/README line mismatch'],
      ],
      [
        'title in index',
        (r) => edit(r, 'docs/roadmap.md', '— beta title', '— other'),
        ['beta: index/README line mismatch'],
      ],
      [
        'tag in index',
        (r) =>
          edit(
            r,
            'docs/roadmap.md',
            '- [ ] [feature] [beta]',
            '- [ ] [prep] [beta]',
          ),
        ['beta: index/README line mismatch'],
      ],
      [
        'header line',
        (r) => edit(r, 'docs/roadmap.md', 'Header paragraph.\n', ''),
        ['line not found anywhere: Header paragraph.'],
      ],
      [
        'rewritten header line',
        (r) =>
          edit(
            r,
            'docs/roadmap.md',
            'This index and the item files',
            'The index',
          ),
        [
          'rewritten header line not found: This index and the item files under `docs/roadmap/` are the single source of tru',
        ],
      ],
      [
        'rules line',
        (r) => edit(r, 'docs/roadmap/RULES.md', 'Grow in place.', 'x'),
        ['line not found anywhere: Grow in place.'],
      ],
    ]
    for (const [name, tamper, want] of cases)
      it(name, () => {
        const root = migrated()
        tamper(root)
        const v = verifyMigration(parseSource(SOURCE_TEXT), SOURCE_TEXT, root)
        expect(v.missing).toEqual(want)
        expect(v.ok).toBe(false)
      })
    it('long lost lines are cut to 80 characters; body rewrites are counted', () => {
      const root = tmp()
      expect(cli(root, 'migrate', SOURCE2).code).toBe(0)
      const clean = verifyMigration(
        parseSource(SOURCE2_TEXT),
        SOURCE2_TEXT,
        root,
      )
      expect(clean).toMatchInlineSnapshot(`
        {
          "bodyLines": 2,
          "itemsChecked": 6,
          "missing": [],
          "ok": true,
          "otherLines": 13,
          "rewrittenLines": 1,
        }
      `)
      edit(root, 'docs/roadmap.md', `${LONG} header line.\n`, '')
      edit(
        root,
        'docs/roadmap/B1/tooling-ci-and-things.md',
        'roadmap rules (`docs/roadmap/RULES.md`)',
        'this file',
      )
      expect(
        verifyMigration(parseSource(SOURCE2_TEXT), SOURCE2_TEXT, root).missing,
      ).toEqual([
        'tooling-ci-and-things: body line not found:   - [ ] see "Change size" in this file',
        `line not found anywhere: ${'L'.repeat(80)}`,
      ])
    })
  })

  it('parseIndex: item lines outside milestones, archive junk, whitespace lines', () => {
    const p = parseIndex(
      [
        '# R',
        '- [ ] stray in header',
        'text - [ ] not an item',
        '## Order',
        '  - [x] stray in order',
        '## M1 — One',
        '   ',
        'Goal.',
        '- [ ] [prep] [a](roadmap/M1/a.md) — A',
        '- [ ] no link',
        '  - [ ] nested',
        'after items',
        '## Archive',
        '  ',
        '- [M0 — Zero](roadmap/archive/M0/README.md)',
        'junk',
        '',
      ].join('\n'),
    )
    expect(p.problems).toEqual([
      { line: 1, msg: 'item line outside a milestone' },
      { line: 4, msg: 'item line outside a milestone' },
      { line: 9, msg: 'malformed item line' },
      {
        line: 10,
        msg: 'indented (nested) line in index; index entries must be single-line',
      },
      {
        line: 11,
        msg: 'non-item line after items; index entries must be single-line',
      },
      { line: 15, msg: 'unexpected line in ## Archive' },
    ])
    expect(p.milestones).toEqual([
      {
        id: 'M1',
        title: 'One',
        start: 5,
        end: 12,
        goal: ['Goal.'],
        items: [p.items[0]],
      },
    ])
    expect(p.archived).toEqual([
      {
        line: 14,
        id: 'M0',
        title: 'Zero',
        link: 'roadmap/archive/M0/README.md',
      },
    ])
    expect(p.archiveStart).toBe(12)
    expect(parseIndex('## M1 — One\n- [x] [a](l) — A').items[0]).toEqual({
      line: 1,
      done: true,
      tag: null,
      slug: 'a',
      link: 'l',
      title: 'A',
      milestone: 'M1',
    })
    expect(parseIndex('## Archive \n- [M0 — Zero](x)').archived).toEqual([])
  })

  it('parseItemFile / stripMeta / parseHeadline / genSlug', () => {
    expect(parseItemFile('x # y\nTag: a')).toEqual({
      heading: null,
      tag: 'a',
      milestone: null,
      title: null,
      status: null,
    })
    expect(parseItemFile('# s\nSee Title: t')).toEqual({
      heading: 's',
      tag: null,
      milestone: null,
      title: null,
      status: null,
    })
    expect(
      stripMeta(
        '# s\n  \nTag: a\nMilestone: m\nTitle: t\n\n# Not meta\nbody\n\n\n',
      ),
    ).toBe('# Not meta\nbody')
    expect(stripMeta('# s\n\nTag: a\n\nSee Tag: x\n')).toBe('See Tag: x')
    expect(parseHeadline('see [prep] y')).toEqual({
      tag: null,
      slug: null,
      title: 'see [prep] y',
    })
    expect(parseHeadline('`only-slug`')).toEqual({
      tag: null,
      slug: 'only-slug',
      title: 'only-slug',
    })
    expect(parseHeadline('`a-b` trailing')).toEqual({
      tag: null,
      slug: null,
      title: '`a-b` trailing',
    })
    expect(parseHeadline('x `a-b` — t')).toEqual({
      tag: null,
      slug: null,
      title: 'x `a-b` — t',
    })
    expect(parseHeadline('[Prep] `a` — t')).toEqual({
      tag: null,
      slug: null,
      title: '[Prep] `a` — t',
    })
    expect(genSlug('Hello  `World`, again: one two three')).toBe(
      'hello-world-again-one-two',
    )
    expect(genSlug('!!!')).toBe('item')
  })

  it('check: one error per broken rule', () => {
    const cases = [
      [
        (r) =>
          edit(
            r,
            'docs/roadmap.md',
            '## Deferred',
            '## A2 — Second\n\n## Deferred',
          ),
        [
          'milestone: A2 appears 2 times in the index',
          'milestone: A2 has no items',
        ],
      ],
      [
        (r) => {
          edit(
            r,
            'docs/roadmap.md',
            '[zeta](roadmap/A2/zeta.md)',
            '[Zeta_x](roadmap/A2/Zeta_x.md)',
          )
          fs.renameSync(
            path.join(r, 'docs/roadmap/A2/zeta.md'),
            path.join(r, 'docs/roadmap/A2/Zeta_x.md'),
          )
          edit(r, 'docs/roadmap/A2/Zeta_x.md', '# zeta', '# Zeta_x')
        },
        ['slug: docs/roadmap.md:31: bad slug Zeta_x'],
      ],
      [
        (r) =>
          edit(r, 'docs/roadmap/A2/zeta.md', 'Milestone: A2', 'Milestone: A1'),
        ['heading: docs/roadmap/A2/zeta.md: Milestone "A1" but index has A2'],
      ],
      [
        (r) =>
          edit(r, 'docs/roadmap.md', '- [ ] [prep] [zeta]', '- [ ] [zeta]'),
        ['meta: docs/roadmap/A2/zeta.md: Tag "prep" but index has none'],
      ],
      [
        (r) => {
          edit(r, 'docs/roadmap.md', '- [ ] [prep] [zeta]', '- [ ] [zeta]')
          edit(r, 'docs/roadmap/A2/zeta.md', 'Tag: prep', 'Tag: none')
        },
        [],
      ],
      [
        (r) => {
          fs.mkdirSync(path.join(r, 'docs/roadmap/archive/A9'))
          fs.copyFileSync(
            path.join(r, 'docs/roadmap/archive/A0/old-slug.md'),
            path.join(r, 'docs/roadmap/archive/A9/old-slug.md'),
          )
          fs.writeFileSync(
            path.join(r, 'docs/roadmap/archive/A9/README.md'),
            '# A9\n',
          )
          edit(
            r,
            'docs/roadmap.md',
            '(roadmap/archive/A0/README.md)',
            '(roadmap/archive/A0/README.md)\n- [A9 — Nine](roadmap/archive/A9/README.md)',
          )
        },
        ['unique: old-slug archived in A0, A9'],
      ],
      [
        (r) =>
          edit(
            r,
            'docs/roadmap.md',
            '(roadmap/archive/A0/README.md)',
            '(roadmap/archive/A0/X.md)',
          ),
        [
          'archive: docs/roadmap.md:39: A0 links roadmap/archive/A0/X.md, expected roadmap/archive/A0/README.md',
        ],
      ],
      [
        (r) => {
          edit(
            r,
            'docs/roadmap.md',
            '(roadmap/archive/A0/README.md)',
            '(roadmap/archive/A0/README.md)\n- [A1 — First](roadmap/archive/A1/README.md)',
          )
          fs.mkdirSync(path.join(r, 'docs/roadmap/archive/A1'))
          fs.writeFileSync(
            path.join(r, 'docs/roadmap/archive/A1/README.md'),
            '# A1\n',
          )
        },
        ['archive: A1 is both active and archived'],
      ],
      [
        (r) =>
          edit(r, 'docs/roadmap.md', '## Archive\n', '## Archive\n   \njunk\n'),
        ['single-line: docs/roadmap.md:39: unexpected line in ## Archive'],
      ],
      [
        (r) => {
          edit(
            r,
            'docs/roadmap.md',
            '## Archive\n',
            '## Archive\n\n- [A7 — Seven](roadmap/archive/A7/README.md)\n- [A7 — Seven](roadmap/archive/A7/README.md)\n',
          )
        },
        [
          'archive: docs/roadmap.md:39: missing folder docs/roadmap/archive/A7/',
          'archive: docs/roadmap.md:40: missing folder docs/roadmap/archive/A7/',
        ],
      ],
    ]
    for (const [tamper, want] of cases) {
      const root = migrated()
      tamper(root)
      expect(errors(root)).toEqual(want)
    }
    const bare = tmp()
    fs.mkdirSync(path.join(bare, 'docs'))
    fs.writeFileSync(
      path.join(bare, 'docs/roadmap.md'),
      '## M1 — x\n\n- [ ] [prep] [a](roadmap/M1/a.md) — t\n',
    )
    expect(errors(bare)).toEqual([
      'file: docs/roadmap.md:3: a: missing file docs/roadmap/M1/a.md',
    ])
  })

  it('add: empty milestone, anchors with --milestone, body handling, refusals', () => {
    const root = migrated()
    edit(
      root,
      'docs/roadmap.md',
      '## Deferred',
      '## A3 — Empty\n\nGoal.\n\n## Deferred',
    )
    expect(errors(root)).toEqual(['milestone: A3 has no items'])
    expect(
      ok(
        root,
        'add',
        'n1',
        '--tag',
        'prep',
        '--title',
        'T',
        '--milestone',
        'A3',
      ),
    ).toBe('added n1 to A3 (A3 (only item)); file docs/roadmap/A3/n1.md')
    expect(idx(root)).toContain(
      '## A3 — Empty\n\nGoal.\n\n- [ ] [prep] [n1](roadmap/A3/n1.md) — T\n\n## Deferred',
    )
    expect(errors(root)).toEqual([])
    expect(
      ok(
        root,
        'add',
        'n2',
        '--tag',
        'prep',
        '--title',
        'T2',
        '--after',
        'beta',
        '--milestone',
        'A1',
      ),
    ).toMatch(/after beta/)
    expect(
      err(
        root,
        'add',
        'n3',
        '--tag',
        'prep',
        '--title',
        'T',
        '--after',
        'beta',
        '--milestone',
        'A2',
      ),
    ).toBe('error: anchor beta is in A1, not A2')
    expect(err(root, 'add', 'n3', '--title', 'T', '--after', 'beta')).toBe(
      'error: --tag required (prep|feature|contingency)',
    )
    expect(
      err(root, 'add', 'n3', '--tag', 'x', '--title', 'T', '--after', 'beta'),
    ).toBe('error: bad tag "x": use prep|feature|contingency')
    expect(err(root, 'add', 'n3', '--tag', 'prep', '--after', 'beta')).toBe(
      'error: --title required',
    )
    fs.writeFileSync(path.join(root, 'docs/roadmap/A1/n3.md'), '# n3\n')
    expect(
      err(
        root,
        'add',
        'n3',
        '--tag',
        'prep',
        '--title',
        'T',
        '--after',
        'beta',
      ),
    ).toBe('error: file already exists: docs/roadmap/A1/n3.md')
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'b.md'), '- [ ] from file\n\n  \n')
    expect(
      run(
        [
          'add',
          'n4',
          '--tag',
          'feature',
          '--title',
          'T',
          '--after',
          'beta',
          '--body-file',
          'b.md',
          '--root',
          root,
        ],
        { cwd: dir },
      ).code,
    ).toBe(0)
    expect(read(root, 'docs/roadmap/A1/n4.md')).toBe(
      '# n4\n\nTag: feature\nMilestone: A1\nTitle: T\n\n## Scope\n\n- [ ] from file\n',
    )
    expect(
      err(
        root,
        'add',
        'n5',
        '--tag',
        'prep',
        '--title',
        'T',
        '--milestone',
        'A0',
      ),
    ).toBe('error: milestone A0 is archived')
  })

  it('done: progress, note formatting; archive refuses existing folder then succeeds', () => {
    const root = migrated()
    const zeta = read(root, 'docs/roadmap/A2/zeta.md')
    expect(ok(root, 'done', 'epsilon')).toBe('done epsilon (A2 1/2)')
    expect(read(root, 'docs/roadmap/A2/epsilon.md')).toMatch(/^Status: done$/m)
    expect(read(root, 'docs/roadmap/A2/epsilon.md')).not.toContain('Done note')
    expect(ok(root, 'move', 'zeta', '--milestone', 'A2', '--top')).toBe(
      'moved zeta within A2 (A2 top); file docs/roadmap/A2/zeta.md',
    )
    fs.writeFileSync(path.join(root, 'docs/roadmap/A2/zeta.md'), zeta + '\n\n')
    ok(root, 'done', 'zeta', '--note', 'n')
    expect(read(root, 'docs/roadmap/A2/zeta.md')).toMatch(
      /Status: done\n[\s\S]*## Done note\n\nn\n$/,
    )
    fs.mkdirSync(path.join(root, 'docs/roadmap/archive/A2'))
    expect(err(root, 'archive', 'A2')).toBe(
      'error: archive folder already exists: docs/roadmap/archive/A2',
    )
    fs.rmdirSync(path.join(root, 'docs/roadmap/archive/A2'))
    expect(ok(root, 'archive', 'A2')).toMatch(/archived A2/)
    expect(read(root, 'docs/roadmap/archive/A2/zeta.md')).toMatch(
      /Status: done\n[\s\S]*## Done note\n\nn\n$/,
    )
    expect(ok(root, 'list')).toMatch(/\narchived: A0, A2$/)
    expect(ok(root, 'show', 'epsilon')).toMatch(
      /^slug: epsilon\ntag: feature\nstatus: done \(archived\)\n/,
    )
    expect(ok(root, 'show', 'epsilon', '--no-body')).not.toContain('---')
    expect(
      idx(root).endsWith(
        '## Archive\n\n- [A0 — Done milestone](roadmap/archive/A0/README.md)\n- [A2 — Second](roadmap/archive/A2/README.md)\n',
      ),
    ).toBe(true)
    const r2 = migrated()
    edit(
      r2,
      'docs/roadmap.md',
      '- [A0 — Done milestone](roadmap/archive/A0/README.md)\n',
      '',
    )
    fs.rmSync(path.join(r2, 'docs/roadmap/archive'), { recursive: true })
    ok(r2, 'done', 'epsilon')
    ok(r2, 'done', 'zeta')
    ok(r2, 'archive', 'A2')
    expect(
      idx(r2).endsWith(
        '## Archive\n\n- [A2 — Second](roadmap/archive/A2/README.md)\n',
      ),
    ).toBe(true)
    expect(errors(r2)).toEqual([])
    const r3 = migrated()
    const archive =
      '## Archive\n\n- [A0 — Done milestone](roadmap/archive/A0/README.md)\n'
    edit(r3, 'docs/roadmap.md', '\n' + archive, '')
    edit(r3, 'docs/roadmap.md', '## A2', archive + '\n## A2')
    ok(r3, 'done', 'epsilon')
    ok(r3, 'done', 'zeta')
    ok(r3, 'archive', 'A2')
    expect(idx(r3).endsWith('`add`.\n')).toBe(true)
    expect(idx(r3)).toContain(
      'README.md)\n- [A2 — Second](roadmap/archive/A2/README.md)\n\n## Deferred',
    )
  })

  it('move: refusals with exact messages', () => {
    const root = migrated()
    expect(err(root, 'move', 'beta', '--after', 'beta')).toBe(
      'error: cannot move an item relative to itself',
    )
    expect(err(root, 'move', 'beta', '--before', 'beta')).toBe(
      'error: cannot move an item relative to itself',
    )
    fs.writeFileSync(path.join(root, 'docs/roadmap/A2/beta.md'), '# x\n')
    expect(err(root, 'move', 'beta', '--milestone', 'A2')).toBe(
      'error: target file exists: docs/roadmap/A2/beta.md',
    )
  })

  it('show / list / next / run details', () => {
    const root = migrated()
    expect(ok(root, 'show', 'alpha')).toMatch(
      /^slug: alpha\ntag: prep\nstatus: done\nmilestone: A1 — First\n/,
    )
    expect(ok(root, 'list', '--milestone', 'A1')).toMatch(
      /^A1 — First \(1\/4 done\)\n\[x\] alpha \(prep\) — alpha title/,
    )
    expect(ok(root, 'next', '--skip', 'beta, delta')).toMatch(
      /^slug: epsilon\n/,
    )
    expect(ok(root, 'next', '--skip', ',')).toMatch(/^slug: beta\n/)
    expect(run(['check'], { cwd: root })).toEqual({
      code: 0,
      out: 'check ok: 6 items (5 open), 2 active milestones, 1 archived',
    })
    expect(err(root, 'next', '--skip')).toBe(
      'error: --skip needs a value (use --skip=<value> for values starting with --)',
    )
    fs.rmSync(path.join(root, 'docs/roadmap/A1/beta.md'))
    expect(ok(root, 'show', 'beta')).toMatch(/\n---\n\(file missing\)$/)
    const io = {
      stdout: {
        s: '',
        write(x) {
          this.s += x
        },
      },
      stderr: {
        s: '',
        write(x) {
          this.s += x
        },
      },
    }
    main(['list', '--milestone', 'A2', '--root', root], io)
    expect([io.stdout.s, io.stderr.s, io.exitCode]).toEqual([
      'A2 — Second (0/2 done)\n[ ] epsilon (feature) — epsilon title\n[ ] zeta (prep) — zeta title\n',
      '',
      0,
    ])
    main(['bogus', '--root', root], io)
    expect(io.stderr.s).toMatch(/^error: unknown command: bogus\n/)
    expect(io.exitCode).toBe(2)
    expect(() => run(['migrate', fixtureDir, '--root', tmp()])).toThrow(
      /EISDIR/,
    )
  })

  it.skipIf(process.getuid?.() === 0)(
    'a failed index write rolls back the new item file',
    () => {
      const root = migrated()
      fs.chmodSync(path.join(root, 'docs'), 0o555)
      try {
        expect(() =>
          cli(
            root,
            'add',
            'r1',
            '--tag',
            'prep',
            '--title',
            'T',
            '--after',
            'beta',
          ),
        ).toThrow(/EACCES/)
        expect(exists(root, 'docs/roadmap/A1/r1.md')).toBe(false)
        expect(() => cli(root, 'move', 'beta', '--milestone', 'A2')).toThrow(
          /EACCES/,
        )
        expect(exists(root, 'docs/roadmap/A2/beta.md')).toBe(false)
        expect(exists(root, 'docs/roadmap/A1/beta.md')).toBe(true)
      } finally {
        fs.chmodSync(path.join(root, 'docs'), 0o755)
      }
    },
  )
})

describe('withFileStatus and assertOpenItem edges', () => {
  it('withFileStatus inserts after Title, replaces Status, or appends', () => {
    expect(withFileStatus('# s\nTitle: T\n\nbody\n', true)).toMatch(
      /Title: T\nStatus: done\n/,
    )
    expect(withFileStatus('# s\nStatus: open\nTitle: T\n', true)).toMatch(
      /^Status: done$/m,
    )
    expect(withFileStatus('# s\nonly\n', false)).toMatch(/Status: open\n$/)
  })

  it('assertOpenItem covers unknown, archived, done, contingency', () => {
    const root = migrated()
    const ctx = load(root)
    expect(assertOpenItem(ctx, 'beta').slug).toBe('beta')
    expect(() => assertOpenItem(ctx, '')).toThrow(/slug required/)
    expect(() => assertOpenItem(ctx, 'nope')).toThrow(/unknown slug/)
    expect(() => assertOpenItem(ctx, 'old-slug')).toThrow(
      /already done \(archived\)/,
    )
    ok(root, 'done', 'beta', '--note', 'n')
    expect(() => assertOpenItem(load(root), 'beta')).toThrow(
      /already done: beta/,
    )
    expect(() => assertOpenItem(load(root), 'gamma')).toThrow(/contingency/)
    expect(
      assertOpenItem(load(root), 'gamma', { includeContingency: true }).slug,
    ).toBe('gamma')
  })

  it('cmdSync is a no-op when nothing pending; cmdArchive refuses open items', () => {
    const root = migrated()
    expect(cmdSync(load(root))).toEqual({ ticked: [], count: 0 })
    expect(ok(root, 'sync')).toMatch(/sync: nothing to tick/)
    expect(() => cmdArchive(load(root), 'A1')).toThrow(/has open items/)
    expect(() => cmdArchive(load(root), '')).toThrow(/usage: archive/)
    expect(cli(root, 'archive').err).toMatch(/usage: archive/)
    expect(cli(root, 'claim').err).toMatch(/usage: claim/)
  })

  it('renderItemFile, claim format, empty milestone archive, archive with sync ticks', () => {
    expect(
      renderItemFile({
        slug: 's',
        tag: 'prep',
        milestone: 'M',
        title: 'T',
        body: ['- [ ] x'],
        status: 'done',
      }),
    ).toMatch(/^# s\n[\s\S]*Status: done\n/)
    expect(
      renderItemFile({
        slug: 's',
        tag: '',
        milestone: 'M',
        title: 'T',
        body: [],
      }),
    ).not.toMatch(/Status:/)

    const root = migrated()
    expect(ok(root, 'claim', 'delta')).toMatch(/claimed delta \(A1, prep\)/)

    const idxPath = path.join(root, 'docs/roadmap.md')
    ensureZ9SectionInRoadmapIndex(idxPath)
    expect(cli(root, 'archive', 'Z9').err).toMatch(/has no items/)

    ok(root, 'done', 'epsilon', '--note', 'n')
    ok(root, 'done', 'zeta', '--note', 'n')
    const arch = ok(root, 'archive', 'A2')
    expect(arch).toMatch(/archived A2/)
    expect(arch).toMatch(/synced ticks:/)

    expect(
      textFormat.claim({ claimed: 'x', milestone: 'M', tag: 'prep' }),
    ).toBe('claimed x (M, prep)')
    expect(textFormat.claim({ claimed: 'x', milestone: 'M', tag: '' })).toBe(
      'claimed x (M)',
    )
    expect(
      textFormat.archive({ archived: 'A', readme: 'r.md', ticked: [] }),
    ).toBe('archived A -> r.md')
    expect(
      textFormat.archive({
        archived: 'A',
        readme: 'r.md',
        ticked: ['a', 'b'],
      }),
    ).toBe('archived A -> r.md\nsynced ticks: a, b')
  })
})
