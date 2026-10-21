import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExec as gitExecIsolated, initTmpRepo } from './git-test-helper.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
import {
  AgentError,
  branchPrefixForItem,
  clearRunStarted,
  collectSkipSlugs,
  cmdPreflight,
  defaultExec,
  ensureRunStarted,
  execEnvForCwd,
  GIT_LOCAL_ENV_VARS,
  isFeatureBranch,
  main,
  mustOk,
  mustOkDiffNoIndex,
  parseArgs,
  parseInstructions,
  parseRoadmapNext,
  parseTouchSetPaths,
  readNvmrcMajor,
  readPushFailures,
  readRunStarted,
  readReviewChecklistIds,
  refreshStaleFeatureBranch,
  resolvePureAddIndexConflict,
  resolveGitRelPath,
  resolveRunStartedMs,
  run,
  readRunStartedMs,
  slugFromBranch,
  slugFromFeatFix,
  stripAnsi,
  summarizePushFailure,
  switchFeatureBranch,
  branchHeldInOtherWorktree,
  gitPath,
  tailOutput,
  tryResolveTrivialConflicts,
  mergeOriginMainIfNeeded,
  buildPrBodyWithMetrics,
  writePushFailures,
  writeRunStarted,
  pushFailPath,
  blobIdsFromRootProtobuf,
  roundsFromStoreMessages,
  roundFromCursorUsage,
  parseStatsRoundsJson,
  loadStatsRounds,
  estimateTokensFromChars,
  messageContentChars,
  isRoundStartingUser,
  isSystemNotificationUser,
  isUserInfoPreamble,
  normalizeRounds,
  readProtobufVarint,
  readyArtifactIds,
  STATS_CHARS_PER_TOKEN,
  hasPrepConcreteScope,
  introducesNewSrcCapability,
  isPrepFastTrack,
  PREP_APPLY_ARCHIVE_PROCEDURE,
  APPLY_ARCHIVE_PROCEDURE,
} from './agent.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

function tmpRoot(withGit = false) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-'))
  tmpDirs.push(d)
  fs.writeFileSync(path.join(d, '.nvmrc'), '22\n')
  fs.mkdirSync(path.join(d, 'openspec', 'changes'), { recursive: true })
  fs.writeFileSync(
    path.join(d, 'openspec', 'config.yaml'),
    [
      'schema: spec-driven',
      'rules:',
      '  proposal:',
      "    - 'Keep proposals under 80 words.'",
      '  design:',
      "    - '## Decisions + ## Touch-set & Test Plan only.'",
      '  tasks:',
      "    - 'At most 8 implementation tasks.'",
      '  specs:',
      "    - 'Prefer invariants; WHEN/THEN only for core flows.'",
      '',
    ].join('\n'),
  )
  if (withGit) {
    fs.mkdirSync(path.join(d, '.git'), { recursive: true })
  }
  return d
}

function gitInitRepo() {
  return initTmpRepo(tmpDirs, { prefix: 'agent-git-' })
}

/** Test-local alias: fixtures use ignore stdio via the shared helper. */
function gitExec(args, cwd, extra = {}) {
  return gitExecIsolated(args, cwd, { stdio: 'ignore', ...extra })
}

function fakeExec(handlers) {
  return (file, args, _opts = {}) => {
    const key = `${file} ${args.join(' ')}`
    for (const [pattern, res] of handlers) {
      if (
        (typeof pattern === 'string' && key.includes(pattern)) ||
        (pattern instanceof RegExp && pattern.test(key))
      ) {
        const out = typeof res === 'function' ? res(file, args) : res
        return {
          code: out.code ?? 0,
          stdout: out.stdout ?? '',
          stderr: out.stderr ?? '',
        }
      }
    }
    // Default empty claimed-set sources so legacy preflight fixtures stay green.
    if (key.includes('git branch --format'))
      return { code: 0, stdout: '', stderr: '' }
    if (key.includes('git worktree list --porcelain'))
      return { code: 0, stdout: '', stderr: '' }
    if (key.includes('git rev-parse --git-path')) {
      const file = args[args.length - 1] ?? 'unknown'
      return { code: 0, stdout: `.git/${file}\n`, stderr: '' }
    }
    // Finish/preflight happy-path fixtures: already based on origin/main.
    if (key.includes('git merge-base --is-ancestor'))
      return { code: 0, stdout: '', stderr: '' }
    if (key.includes('git fetch origin'))
      return { code: 0, stdout: '', stderr: '' }
    if (key.includes('git rev-list --count HEAD..origin/main'))
      return { code: 0, stdout: '0\n', stderr: '' }
    if (key.includes('openspec status'))
      return {
        code: 0,
        stdout:
          JSON.stringify({
            artifacts: [{ id: 'proposal', status: 'ready' }],
          }) + '\n',
        stderr: '',
      }
    return { code: 1, stdout: '', stderr: `unhandled: ${key}` }
  }
}

const envOk = [
  ['node -v', { stdout: 'v22.23.3\n' }],
  ['command -v pnpm', { code: 0 }],
]

const HELP_SNIPPETS = [
  'usage: pnpm agent <cmd> [--root <repo>] [--json] [--quiet]',
  'preflight [--slug S] [--skip a,b]',
  'finish --title T --body-file F',
  'stamp-green',
  'review-brief [--change S] [--base REF] [--rules-json',
  'size [--plan]',
  'manual-qa',
  'instructions <artifact>',
  'archive [--change S]',
  'stats <path>',
  'source scripts/agent-env.sh',
  'Prefer --json for machine branching.',
]

describe('parseArgs', () => {
  it('parses bool and value flags including --key=value', () => {
    const o = parseArgs([
      'preflight',
      '--json',
      '--quiet',
      '--skip',
      'a,b',
      '--root',
      '.',
      '--base',
      'origin/main',
    ])
    expect(o).toEqual({
      _: ['preflight'],
      json: true,
      quiet: true,
      skip: 'a,b',
      root: '.',
      base: 'origin/main',
    })
    expect(parseArgs(['finish', '--root=./repo', '--title=Hi'])).toEqual({
      _: ['finish'],
      root: './repo',
      title: 'Hi',
    })
  })

  it('rejects unknown options with exact message', () => {
    expect(() => parseArgs(['x', '--nope'])).toThrow(AgentError)
    expect(() => parseArgs(['x', '--nope'])).toThrow('unknown option --nope')
  })

  it('rejects missing values with exact message', () => {
    expect(() => parseArgs(['x', '--root'])).toThrow(
      '--root needs a value (use --root=<value> for values starting with --)',
    )
    expect(() => parseArgs(['x', '--root', '--json'])).toThrow(
      '--root needs a value (use --root=<value> for values starting with --)',
    )
  })
})

describe('stripAnsi / tailOutput', () => {
  it('strips CSI sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi(null)).toBe('')
    expect(stripAnsi(undefined)).toBe('')
  })

  it('tails last N lines and defaults to 60', () => {
    expect(tailOutput('', '')).toBe('(no output)')
    expect(tailOutput('   ', '  ')).toBe('(no output)')
    expect(tailOutput(null, undefined)).toBe('(no output)')
    expect(tailOutput('a\n'.repeat(100), '', 3)).toBe('a\na\na')
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n')
    expect(tailOutput(lines, '').split('\n')).toHaveLength(60)
    expect(tailOutput(lines, '').split('\n')[0]).toBe('L40')
    expect(tailOutput('out', 'err', 10)).toBe('out\nerr')
  })
})

describe('mustOk', () => {
  it('returns result when code is 0', () => {
    const r = { code: 0, stdout: 'ok', stderr: '' }
    expect(mustOk(r, 'lab')).toBe(r)
  })

  it('throws with tailed streams and preserves exit code', () => {
    try {
      mustOk(
        { code: 7, stdout: 'ELIFECYCLE\n', stderr: 'real error line\n' },
        'verify',
      )
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AgentError)
      expect(e.exitCode).toBe(7)
      expect(e.message).toBe(
        'verify failed (exit 7):\nELIFECYCLE\n\nreal error line',
      )
    }
  })

  it('uses exit 1 when code is falsy but non-zero path', () => {
    try {
      mustOk({ code: undefined, stdout: '', stderr: 'x' }, 'lab')
      expect.unreachable()
    } catch (e) {
      expect(e.exitCode).toBe(1)
      expect(e.message).toBe('lab failed (exit undefined):\nx')
    }
  })
})

describe('parsers', () => {
  it('parseRoadmapNext JSON and text forms', () => {
    const j = parseRoadmapNext(
      JSON.stringify({
        slug: 's',
        tag: 'prep',
        title: 't',
        file: 'f',
        milestone: 'M2.1',
        goal: ['g'],
        body: 'body',
      }),
    )
    expect(j).toEqual({
      slug: 's',
      tag: 'prep',
      title: 't',
      file: 'f',
      milestone: 'M2.1',
      goal: ['g'],
      body: 'body',
    })
    const text = parseRoadmapNext(
      [
        'slug: alpha',
        'tag: prep',
        'title: Hello',
        'file: docs/x.md',
        'milestone: M2.1 — Q',
        'goal: one',
        'goal: two',
        '---',
        'body line',
      ].join('\n'),
    )
    expect(text).toEqual({
      slug: 'alpha',
      tag: 'prep',
      title: 'Hello',
      file: 'docs/x.md',
      milestone: 'M2.1 — Q',
      goal: ['one', 'two'],
      body: 'body line',
    })
    const bodyFirst = parseRoadmapNext('---\nslug: s\nrest\n')
    expect(bodyFirst.slug).toBe('s')
    expect(bodyFirst.body).toBe('slug: s\nrest\n')
    const noBody = parseRoadmapNext('slug: only\ntag: prep\n')
    expect(noBody.body).toBeUndefined()
    expect(noBody.tag).toBe('prep')
  })

  it('isPrepFastTrack needs Tag prep plus Scope checkbox and Done when', () => {
    const body =
      '## Scope\n\n- [ ] do the work\n- **Done when:** green checks\n'
    expect(hasPrepConcreteScope(body)).toBe(true)
    expect(hasPrepConcreteScope('## Scope\n- [ ] a')).toBe(false)
    expect(hasPrepConcreteScope('- [ ] a\n- **Done when:** x')).toBe(false)
    expect(isPrepFastTrack({ tag: 'prep', body })).toBe(true)
    expect(isPrepFastTrack({ tag: 'contingency', body })).toBe(true)
    expect(isPrepFastTrack({ tag: 'feature', body })).toBe(false)
    expect(isPrepFastTrack({ tag: 'prep', body: '## Scope\n- [ ] a' })).toBe(
      false,
    )
    expect(PREP_APPLY_ARCHIVE_PROCEDURE.split('\n').length).toBeLessThanOrEqual(
      10,
    )
    expect(APPLY_ARCHIVE_PROCEDURE.split('\n').length).toBeLessThanOrEqual(10)
    expect(PREP_APPLY_ARCHIVE_PROCEDURE).toContain(
      'Skip openspec-planning-reviewer',
    )
    expect(PREP_APPLY_ARCHIVE_PROCEDURE).toContain('skip_specs:true')
    expect(APPLY_ARCHIVE_PROCEDURE).toContain('docs/agent-loop.md')
    expect(PREP_APPLY_ARCHIVE_PROCEDURE).toContain('docs/agent-loop.md')
  })

  it('isPrepFastTrack false when roadmap introduces missing src/<capability>/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-new-cap-'))
    tmpDirs.push(root)
    fs.mkdirSync(path.join(root, 'src', 'editor'), { recursive: true })
    const scope = '## Scope\n\n- [ ] ship it\n- **Done when:** done\n'
    const existing = `${scope}\nTouch \`src/editor/\` helpers.\n`
    const missing = `${scope}\nAdd \`src/brand-new-cap/\` domain module.\n`
    const dup = `${scope}\nSee src/brand-new-cap/ and again src/brand-new-cap/.\n`
    expect(introducesNewSrcCapability(root, undefined)).toBe(false)
    expect(introducesNewSrcCapability(root, existing)).toBe(false)
    expect(introducesNewSrcCapability(root, missing)).toBe(true)
    expect(introducesNewSrcCapability(root, dup)).toBe(true)
    expect(introducesNewSrcCapability(root, `${scope}\nsrc/editor\n`)).toBe(
      false,
    )
    expect(isPrepFastTrack({ tag: 'prep', body: existing }, root)).toBe(true)
    expect(isPrepFastTrack({ tag: 'prep', body: missing }, root)).toBe(false)
    expect(isPrepFastTrack({ tag: 'contingency', body: missing }, root)).toBe(
      false,
    )
    expect(isPrepFastTrack({ tag: 'prep', body: existing })).toBe(true)
  })

  it('parseRoadmapNext failure messages', () => {
    expect(() => parseRoadmapNext('{}')).toThrow(
      'roadmap next JSON missing slug',
    )
    expect(() => parseRoadmapNext('not json and no slug')).toThrow(
      'roadmap next produced no slug',
    )
  })

  it('parseInstructions defaults missing fields to null', () => {
    expect(parseInstructions('{"template":"T","rules":["r"]}')).toEqual({
      template: 'T',
      rules: ['r'],
    })
    expect(parseInstructions('{}')).toEqual({ template: null, rules: null })
    expect(() => parseInstructions('nope')).toThrow()
  })

  it('parseTouchSetPaths skips header and ellipsis rows', () => {
    expect(
      parseTouchSetPaths(
        '| `scripts/agent.mjs` | cli |\n| File | Why |\n| `a…b` | skip |\n| `ok.ts` | x |',
      ),
    ).toEqual(['scripts/agent.mjs', 'ok.ts'])
    expect(parseTouchSetPaths('| no-ticks | x |')).toEqual([])
    expect(parseTouchSetPaths('not a table')).toEqual([])
  })
})

describe('branch and check helpers', () => {
  it('branchPrefixForItem', () => {
    expect(branchPrefixForItem({ tag: 'prep', title: 'x' })).toBe('feat')
    expect(branchPrefixForItem({ tag: 'fix', title: 'x' })).toBe('fix')
    expect(branchPrefixForItem({ tag: 'prep', title: 'fix a bug' })).toBe('fix')
    expect(branchPrefixForItem({ tag: 'prep', title: undefined })).toBe('feat')
    expect(branchPrefixForItem({ tag: 'prep' })).toBe('feat')
  })

  it('isFeatureBranch and slugFromBranch', () => {
    expect(isFeatureBranch('feat/x')).toBe(true)
    expect(isFeatureBranch('fix/y')).toBe(true)
    expect(isFeatureBranch('main')).toBe(false)
    expect(isFeatureBranch('feature/x')).toBe(false)
    expect(slugFromBranch('feat/demo')).toBe('demo')
    expect(slugFromBranch('fix/demo')).toBe('demo')
    expect(slugFromBranch('main')).toBe('main')
  })
})

describe('execEnvForCwd', () => {
  it('strips repo-local GIT_* and keeps SSH / terminal prompt', () => {
    const env = {
      PATH: '/bin',
      GIT_DIR: '/decoy/.git',
      GIT_WORK_TREE: '/decoy',
      GIT_COMMON_DIR: '/decoy/.git',
      GIT_CONFIG: '/decoy/config',
      GIT_CONFIG_PARAMETERS: "'core.bare=true'",
      GIT_CONFIG_COUNT: '1',
      GIT_PREFIX: 'x',
      GIT_IMPLICIT_WORK_TREE: '1',
      GIT_GRAFT_FILE: 'g',
      GIT_SHALLOW_FILE: 's',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_REPLACE_REF_BASE: 'r',
      GIT_INTERNAL_SUPER_PREFIX: 'p',
      GIT_INDEX_FILE: 'i',
      GIT_OBJECT_DIRECTORY: 'o',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'a',
      GIT_SSH_COMMAND: 'ssh -i key',
      GIT_TERMINAL_PROMPT: '0',
    }
    const out = execEnvForCwd(env)
    for (const key of GIT_LOCAL_ENV_VARS) expect(out[key]).toBeUndefined()
    expect(out.PATH).toBe('/bin')
    expect(out.GIT_SSH_COMMAND).toBe('ssh -i key')
    expect(out.GIT_TERMINAL_PROMPT).toBe('0')
  })
})

describe('run metrics helpers', () => {
  it('writeRunStarted and buildPrBodyWithMetrics fill wall time and tokens', () => {
    const root = tmpRoot(true)
    writeRunStarted(root, 1_000, defaultExec, 'feat/demo')
    const body = path.join(root, 'body.md')
    fs.writeFileSync(
      body,
      '## Summary\n\nok\n\n## Metrics\n\n- wall_time_sec: stale\n\n## OpenSpec\n\nx\n',
    )
    const { bodyPath, wallTimeSec, tokens } = buildPrBodyWithMetrics(
      body,
      root,
      { AGENT_TOKEN_USAGE: '99' },
      defaultExec,
      6_000,
    )
    expect(wallTimeSec).toBe(5)
    expect(tokens).toBe('99')
    const text = fs.readFileSync(bodyPath, 'utf8')
    expect(text).toContain('wall_time_sec: 5')
    expect(text).toContain('tokens: 99')
    expect(text).toContain('## OpenSpec')
    expect(text).not.toContain('stale')
  })

  it('buildPrBodyWithMetrics appends when Metrics section is absent', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, '## Summary\n')
    const { bodyPath, wallTimeSec, tokens } = buildPrBodyWithMetrics(
      body,
      root,
      {},
      defaultExec,
      Date.now(),
    )
    expect(wallTimeSec).toBe(null)
    expect(tokens).toBe(null)
    expect(fs.readFileSync(bodyPath, 'utf8')).toMatch(
      /## Metrics\n\n- wall_time_sec: unknown\n/,
    )
  })

  it('buildPrBodyWithMetrics replaces trailing Metrics when no following heading', () => {
    const root = tmpRoot(true)
    writeRunStarted(root, 2_000, defaultExec, 'feat/x')
    const body = path.join(root, 'body.md')
    fs.writeFileSync(
      body,
      '## Summary\n\nok\n\n## Metrics\n\n- wall_time_sec: old\n',
    )
    const { bodyPath, wallTimeSec } = buildPrBodyWithMetrics(
      body,
      root,
      {},
      defaultExec,
      7_000,
    )
    expect(wallTimeSec).toBe(5)
    expect(fs.readFileSync(bodyPath, 'utf8')).toMatch(
      /## Metrics\n\n- wall_time_sec: 5\n$/,
    )
    expect(fs.readFileSync(bodyPath, 'utf8')).not.toContain('old')
  })

  it('AGENT_RUN_STARTED_AT env wins over the on-disk marker', () => {
    const root = tmpRoot(true)
    writeRunStarted(root, 1_000, defaultExec, 'feat/x')
    expect(resolveRunStartedMs(root, { AGENT_RUN_STARTED_AT: '10' })).toBe(
      10_000,
    )
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, '## Summary\n')
    const { wallTimeSec } = buildPrBodyWithMetrics(
      body,
      root,
      { AGENT_RUN_STARTED_AT: '10' },
      defaultExec,
      15_000,
    )
    expect(wallTimeSec).toBe(5)
  })

  it('ensureRunStarted keeps the first marker for the same branch', () => {
    const root = tmpRoot(true)
    const first = ensureRunStarted(root, 'feat/a', 1_000)
    expect(first.wrote).toBe(true)
    const second = ensureRunStarted(root, 'feat/a', 9_999)
    expect(second.wrote).toBe(false)
    expect(second.startedAtMs).toBe(1_000)
    expect(readRunStarted(root)).toEqual({
      startedAtMs: 1_000,
      branch: 'feat/a',
    })
  })

  it('ensureRunStarted rewrites when the branch changes', () => {
    const root = tmpRoot(true)
    ensureRunStarted(root, 'feat/a', 1_000)
    const next = ensureRunStarted(root, 'feat/b', 5_000)
    expect(next.wrote).toBe(true)
    expect(readRunStarted(root)).toEqual({
      startedAtMs: 5_000,
      branch: 'feat/b',
    })
  })

  it('readRunStarted ignores corrupt or non-numeric markers', () => {
    const root = tmpRoot(true)
    const p = resolveGitRelPath(root, 'agent-run-started.json')
    fs.writeFileSync(p, '{not-json')
    expect(readRunStarted(root)).toBe(null)
    expect(readRunStartedMs(root)).toBe(null)
    fs.writeFileSync(p, JSON.stringify({ startedAtMs: 'nope', branch: 'x' }))
    expect(readRunStarted(root)).toBe(null)
    fs.writeFileSync(p, JSON.stringify({ branch: 'x' }))
    expect(readRunStarted(root)).toBe(null)
    fs.writeFileSync(
      p,
      JSON.stringify({ startedAtMs: Number.NaN, branch: 'x' }),
    )
    expect(readRunStarted(root)).toBe(null)
    fs.writeFileSync(
      p,
      JSON.stringify({ startedAtMs: Number.POSITIVE_INFINITY, branch: 'x' }),
    )
    expect(readRunStarted(root)).toBe(null)
    fs.writeFileSync(p, JSON.stringify({ startedAtMs: 42 }))
    expect(readRunStarted(root)).toEqual({ startedAtMs: 42, branch: '' })
    writeRunStarted(root, 7, defaultExec, null)
    expect(readRunStarted(root)).toEqual({ startedAtMs: 7, branch: '' })
  })

  it('resolveRunStartedMs ignores non-finite AGENT_RUN_STARTED_AT', () => {
    const root = tmpRoot(true)
    writeRunStarted(root, 1_000, defaultExec, 'feat/x')
    expect(resolveRunStartedMs(root, { AGENT_RUN_STARTED_AT: 'nope' })).toBe(
      1_000,
    )
    expect(resolveRunStartedMs(root, { AGENT_RUN_STARTED_AT: '  ' })).toBe(
      1_000,
    )
    expect(resolveRunStartedMs(root, { AGENT_RUN_STARTED_AT: '' })).toBe(1_000)
  })

  it('resolveGitRelPath falls back when gitPath throws', () => {
    const root = tmpRoot(true)
    const p = resolveGitRelPath(root, 'agent-x.json', () => {
      throw new Error('rev-parse down')
    })
    expect(p).toBe(path.join(root, '.git', 'agent-x.json'))
  })

  it('clearRunStarted removes the marker file', () => {
    const root = tmpRoot(true)
    writeRunStarted(root, 1_000, defaultExec, 'feat/x')
    expect(readRunStartedMs(root)).toBe(1_000)
    clearRunStarted(root)
    expect(readRunStarted(root)).toBe(null)
  })
})

describe('nvmrc and push failures', () => {
  it('readNvmrcMajor missing bad and valid', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bare-'))
    tmpDirs.push(bare)
    expect(readNvmrcMajor(bare)).toBe(null)
    fs.writeFileSync(path.join(bare, '.nvmrc'), 'nope\n')
    expect(readNvmrcMajor(bare)).toBe(null)
    fs.writeFileSync(path.join(bare, '.nvmrc'), 'v22.1\n')
    expect(readNvmrcMajor(bare)).toBe(22)
    const root = tmpRoot()
    expect(readNvmrcMajor(root)).toBe(22)
  })

  it('readPushFailures empty corrupt and write roundtrip', () => {
    const root = tmpRoot(true)
    expect(readPushFailures(root)).toEqual({})
    writePushFailures(root, { 'feat/x': 1 })
    expect(readPushFailures(root)).toEqual({ 'feat/x': 1 })
    expect(pushFailPath(root)).toBe(
      path.join(root, '.git', 'agent-finish-push-failures.json'),
    )
    fs.writeFileSync(pushFailPath(root), '{not-json')
    expect(readPushFailures(root)).toEqual({})
  })

  it('writePushFailures requires a git dir', () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nogit-'))
    tmpDirs.push(noGit)
    expect(() => writePushFailures(noGit, {})).toThrow(
      /git rev-parse --git-path/,
    )
  })

  it('gitPath fails when .git is a file and rev-parse fails', () => {
    const root = tmpRoot()
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /nonexistent\n')
    expect(() => pushFailPath(root)).toThrow(/git rev-parse --git-path/)
  })

  it('gitPath falls back to .git directory when rev-parse fails', () => {
    const root = tmpRoot(true)
    const p = gitPath(root, 'agent-x.json', () => ({
      code: 1,
      stdout: '',
      stderr: 'nope',
    }))
    expect(p).toBe(path.join(root, '.git', 'agent-x.json'))
  })

  it('pushFailPath uses git-dir in a linked worktree', () => {
    const primary = gitInitRepo()
    gitExec(['branch', '-M', 'main'], primary)
    const wt = path.join(primary, '..', `wt-${path.basename(primary)}`)
    tmpDirs.push(wt)
    gitExec(['worktree', 'add', wt, '-b', 'feat/wt-item'], primary)
    writePushFailures(wt, { 'feat/wt-item': 1 })
    const p = pushFailPath(wt)
    expect(fs.existsSync(p)).toBe(true)
    expect(readPushFailures(wt)).toEqual({ 'feat/wt-item': 1 })
    expect(p.includes('.git')).toBe(true)
  })
})

describe('preflight', () => {
  it('happy path --json includes body goal milestone', () => {
    const root = tmpRoot()
    const item = {
      slug: 'demo-item',
      tag: 'prep',
      title: 'Fewer calls',
      file: 'docs/roadmap/M2.1/demo-item.md',
      milestone: 'M2.1 — Q',
      goal: ['goal text'],
      body: '## Scope\n- [ ] a',
    }
    const exec = fakeExec([
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git fetch origin', { code: 0 }],
      ['git switch main', { code: 0 }],
      ['git pull --ff-only', { code: 0 }],
      ['gh pr list', { stdout: 'feat/other\n' }],
      ['git branch -r', { stdout: '  origin/feat/remote-one\n' }],
      ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
      ['git switch -c feat/demo-item', { code: 0 }],
    ])
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec,
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(true)
    expect(j.item).toEqual({
      slug: 'demo-item',
      tag: 'prep',
      title: 'Fewer calls',
      file: 'docs/roadmap/M2.1/demo-item.md',
      milestone: 'M2.1 — Q',
      goal: ['goal text'],
      body: '## Scope\n- [ ] a',
    })
    expect(j.skips).toEqual(expect.arrayContaining(['other', 'remote-one']))
    expect(j.instructions.rules).toEqual(['Keep proposals under 80 words.'])
    expect(j.instructions.template).toContain('## Proposal')
    expect(j.runCard.ready).toEqual(['proposal'])
    expect(j.runCard.artifacts.proposal).toEqual(j.instructions)
    expect(
      fs.existsSync(
        path.join(root, 'openspec', 'changes', 'demo-item', '.openspec.yaml'),
      ),
    ).toBe(true)
    expect(j.prepFastTrack).toBe(false)
    expect(j.runCard.prepFastTrack).toBe(false)
    expect(j.runCard.procedure).toContain('openspec-planning-reviewer')
    expect(j.runCard.procedure.split('\n').length).toBeLessThanOrEqual(10)
    expect(j.touchSet).toBe('TBD until design.md')
    expect(j.branch).toBe('feat/demo-item')
  })

  it('prep fast-track procedure when Scope+Done when present', () => {
    const root = tmpRoot()
    const item = {
      slug: 'demo-item',
      tag: 'prep',
      title: 'Gate tweak',
      file: 'docs/roadmap/M2.1/demo-item.md',
      milestone: 'M2.1',
      goal: ['g'],
      body: '## Scope\n- [ ] tweak gates\n- **Done when:** check is green\n',
    }
    const exec = fakeExec([
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git fetch origin', { code: 0 }],
      ['git switch main', { code: 0 }],
      ['git pull --ff-only', { code: 0 }],
      ['gh pr list', { stdout: '' }],
      ['git branch -r', { stdout: '' }],
      ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
      ['git switch -c feat/demo-item', { code: 0 }],
    ])
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec,
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.prepFastTrack).toBe(true)
    expect(j.runCard.prepFastTrack).toBe(true)
    expect(j.runCard.procedure).toBe(PREP_APPLY_ARCHIVE_PROCEDURE)
    expect(j.runCard.procedure).toContain('Skip openspec-planning-reviewer')
    expect(j.touchSet).toBe('prep fast-track (design.md optional)')
  })

  it('text mode prints exact sections for rules template body', () => {
    const root = tmpRoot()
    const item = {
      slug: 'demo-item',
      tag: 'prep',
      title: 't',
      file: 'f',
      milestone: 'M',
      goal: ['g1', 'g2'],
      body: 'BODY',
    }
    const exec = fakeExec([
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git fetch origin', { code: 0 }],
      ['git switch main', { code: 0 }],
      ['git pull --ff-only', { code: 0 }],
      ['gh pr list', { stdout: '' }],
      ['git branch -r', { stdout: '' }],
      ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
      ['git switch -c feat/demo-item', { code: 0 }],
    ])
    const r = run(['preflight', '--root', root], { cwd: root, exec, env: {} })
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('ok: true')
    expect(r.out).toContain('slug: demo-item')
    expect(r.out).toContain(
      'instructions: rules=1 (use --json for template/rules)',
    )
    expect(r.out).toContain('runCard.ready: proposal')
    expect(r.out).toContain('--- runCard artifact: proposal (rules=1) ---')
    expect(r.out).toContain('## Proposal')
    expect(r.out).toContain('- Keep proposals under 80 words.')
    expect(r.out).toContain('prepFastTrack: false')
    expect(r.out).toContain('--- apply/archive procedure ---')
    expect(r.out).toContain('openspec-planning-reviewer')
  })

  it('text mode prints (none) for empty rules and string goal', () => {
    const root = tmpRoot()
    fs.writeFileSync(
      path.join(root, 'openspec', 'config.yaml'),
      'schema: spec-driven\nrules:\n  proposal: []\n',
    )
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'demo-item'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'openspec', 'changes', 'demo-item', 'design.md'),
      '| `AGENTS.md` | nav |\n',
    )
    const item = {
      slug: 'demo-item',
      tag: null,
      title: '',
      file: '',
      goal: 'single-goal',
      body: null,
    }
    const r = run(['preflight', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 1 }],
        ['git branch --show-current', { stdout: 'main\n' }],
        ['git show-ref --verify', { code: 0 }],
        [
          'git merge-base feat/demo-item origin/main',
          { code: 0, stdout: 'a\n' },
        ],
        [
          'git worktree list --porcelain',
          { stdout: `worktree ${root}\nHEAD a\nbranch refs/heads/main\n` },
        ],
        ['git switch feat/demo-item', { code: 0 }],
      ]),
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('goal: single-goal')
    expect(r.out).toContain('touchSet: openspec/changes/demo-item/design.md')
    expect(r.out).toContain('checklistIds: ')
    expect(r.out).toContain(
      'instructions: rules=0 (use --json for template/rules)',
    )
  })

  it('fails on dirty tree with exact message', () => {
    const root = tmpRoot()
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: ' M README.md\n' }],
      ]),
      env: {},
    })
    expect(r.code).toBe(2)
    expect(JSON.parse(r.err).error).toBe('working tree not clean:\nM README.md')
  })

  it('fails when gh pr list fails', () => {
    const root = tmpRoot()
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { code: 1, stderr: 'auth required\n' }],
      ]),
      env: {},
    })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe(
      'gh pr list failed (cannot build skip-list):\nauth required',
    )
  })

  it('fails when git branch -r fails', () => {
    const root = tmpRoot()
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { code: 1, stderr: 'fatal\n' }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toBe('git branch -r failed:\nfatal')
  })

  it('fails when openspec config is missing', () => {
    const root = tmpRoot()
    fs.rmSync(path.join(root, 'openspec', 'config.yaml'), { force: true })
    const item = { slug: 'demo-item', tag: 'prep', title: 't', file: 'f' }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 0 }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toMatch(/^openspec instructions failed/)
    expect(JSON.parse(r.err).error).toContain('openspec/config.yaml missing')
  })

  it('fails when openspec config.yaml is invalid YAML object', () => {
    const root = tmpRoot()
    fs.writeFileSync(path.join(root, 'openspec', 'config.yaml'), '[]\n')
    const item = { slug: 'demo-item', tag: 'prep', title: 't', file: 'f' }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 0 }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toMatch(/^openspec instructions failed/)
    expect(JSON.parse(r.err).error).toContain('did not parse to an object')
  })

  it('fails when rules is not an array', () => {
    const root = tmpRoot()
    fs.writeFileSync(
      path.join(root, 'openspec', 'config.yaml'),
      'schema: spec-driven\nrules:\n  proposal: not-an-array\n',
    )
    const item = { slug: 'demo-item', tag: 'prep', title: 't', file: 'f' }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 0 }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toBe(
      'openspec instructions missing rules array',
    )
  })

  it('fails on wrong node major and missing pnpm', () => {
    const root = tmpRoot()
    const r1 = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([['node -v', { stdout: 'v18.0.0\n' }]]),
      env: {},
    })
    expect(JSON.parse(r1.err).error).toBe(
      'node major is 18; need 22 from .nvmrc (source scripts/agent-env.sh)',
    )
    const r2 = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ['node -v', { stdout: 'v22.0.0\n' }],
        ['command -v pnpm', { code: 1 }],
      ]),
      env: {},
    })
    expect(JSON.parse(r2.err).error).toBe(
      'pnpm not on PATH (source scripts/agent-env.sh once)',
    )
    const r3 = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ['node -v', { code: 1, stderr: 'gone\n' }],
        ['command -v pnpm', { code: 0 }],
      ]),
      env: {},
    })
    expect(JSON.parse(r3.err).error).toBe(
      'node major is missing; need 22 from .nvmrc (source scripts/agent-env.sh)',
    )
  })

  it('passes --skip from open PRs remotes and flag', () => {
    const root = tmpRoot()
    const item = { slug: 'keep', tag: 'prep', title: 't', file: 'f' }
    let nextArgs = null
    const r = run(['preflight', '--json', '--root', root, '--skip', 'extra'], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: 'fix/from-pr\n' }],
        ['git branch -r', { stdout: '  origin/fix/from-remote\n' }],
        [
          'pnpm -s roadmap next --json',
          (file, args) => {
            nextArgs = args
            return { stdout: JSON.stringify(item) }
          },
        ],
        ['git switch -c feat/keep', { code: 0 }],
        ['openspec new change', { code: 0 }],
        [
          'openspec instructions proposal',
          { stdout: JSON.stringify({ template: 'T', rules: ['r'] }) },
        ],
      ]),
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    expect(nextArgs).toEqual([
      '-s',
      'roadmap',
      'next',
      '--json',
      '--skip',
      'extra,from-pr,from-remote',
    ])
    expect(JSON.parse(r.out).branch).toBe('feat/keep')
    const startedAtMs = readRunStartedMs(root)
    expect(typeof startedAtMs).toBe('number')
    expect(startedAtMs).toBeGreaterThan(0)
    expect(readRunStarted(root)?.branch).toBe('feat/keep')

    // Second preflight on the same branch must not reset the clock.
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'keep'), {
      recursive: true,
    })
    const again = run(
      ['preflight', '--json', '--root', root, '--skip', 'extra'],
      {
        cwd: root,
        exec: fakeExec([
          ...envOk,
          ['git status --porcelain', { stdout: '' }],
          ['git fetch origin', { code: 0 }],
          ['git switch main', { code: 0 }],
          ['git pull --ff-only', { code: 0 }],
          ['gh pr list', { stdout: 'fix/from-pr\n' }],
          ['git branch -r', { stdout: '  origin/fix/from-remote\n' }],
          ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
          ['git switch -c feat/keep', { code: 0 }],
          [
            'openspec instructions proposal',
            { stdout: JSON.stringify({ template: 'T', rules: ['r'] }) },
          ],
        ]),
        env: {},
      },
    )
    expect(again.code, again.err).toBe(0)
    expect(readRunStartedMs(root)).toBe(startedAtMs)
  })

  it('reuses existing local branch when switch -c fails and merge-base ok', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'reuse-item'), {
      recursive: true,
    })
    const item = { slug: 'reuse-item', tag: 'prep', title: 't', file: 'f' }
    const calls = []
    const exec = (file, args) => {
      calls.push([file, [...args]])
      const key = `${file} ${args.join(' ')}`
      if (key.includes('node -v'))
        return { code: 0, stdout: 'v22.0.0\n', stderr: '' }
      if (key.includes('command -v pnpm'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git status --porcelain'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git fetch')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git switch main'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git pull')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('gh pr list')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git branch -r'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git branch --format'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git worktree list'))
        return {
          code: 0,
          stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`,
          stderr: '',
        }
      if (key.includes('roadmap next'))
        return { code: 0, stdout: JSON.stringify(item), stderr: '' }
      if (key.includes('git switch -c'))
        return { code: 1, stdout: '', stderr: 'already exists\n' }
      if (key.includes('git branch --show-current'))
        return { code: 0, stdout: 'main\n', stderr: '' }
      if (key.includes('git show-ref --verify'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git merge-base feat/reuse-item origin/main'))
        return { code: 0, stdout: 'abc\n', stderr: '' }
      if (key === 'git switch feat/reuse-item')
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git rev-list --count HEAD..origin/main'))
        return { code: 0, stdout: '0\n', stderr: '' }
      if (key.includes('openspec status'))
        return {
          code: 0,
          stdout:
            JSON.stringify({
              artifacts: [{ id: 'proposal', status: 'ready' }],
            }) + '\n',
          stderr: '',
        }
      if (key.includes('openspec instructions'))
        return {
          code: 0,
          stdout: JSON.stringify({ template: 'T', rules: ['r'] }),
          stderr: '',
        }
      return { code: 1, stdout: '', stderr: `unhandled ${key}` }
    }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec,
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    expect(calls).toContainEqual(['git', ['switch', '-c', 'feat/reuse-item']])
    expect(calls).toContainEqual(['git', ['switch', 'feat/reuse-item']])
  })

  it('reports error when switch -c fails and branch cannot be reused', () => {
    const root = tmpRoot()
    const item = { slug: 'reuse-item', tag: 'prep', title: 't', file: 'f' }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['git branch --format', { stdout: '' }],
        ['git worktree list --porcelain', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/reuse-item', { code: 1, stderr: 'exists\n' }],
        ['git branch --show-current', { stdout: 'main\n' }],
        ['git show-ref --verify', { code: 1, stderr: 'missing\n' }],
      ]),
      env: {},
    })
    expect(r.code).not.toBe(0)
    expect(JSON.parse(r.err).error).toMatch(
      /cannot create branch feat\/reuse-item/,
    )
    expect(JSON.parse(r.err).error).toContain('exists')
  })

  it('records exact argv for sync skip and branch create (native openspec)', () => {
    const root = tmpRoot()
    const item = {
      slug: 'argv-item',
      tag: 'prep',
      title: 't',
      file: 'f',
      goal: ['g'],
    }
    const calls = []
    const exec = (file, args) => {
      calls.push([file, [...args]])
      const key = `${file} ${args.join(' ')}`
      if (key.includes('node -v'))
        return { code: 0, stdout: 'v22.0.0\n', stderr: '' }
      if (key.includes('command -v pnpm'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git status --porcelain'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git fetch')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git switch main'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git pull')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('gh pr list'))
        return { code: 0, stdout: 'feat/skip-me\n', stderr: '' }
      if (key.includes('git branch -r'))
        return {
          code: 0,
          stdout: '  origin/feat/remote-a\n  origin/main\n',
          stderr: '',
        }
      if (key.includes('git branch --format'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git worktree list'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('roadmap next'))
        return { code: 0, stdout: JSON.stringify(item), stderr: '' }
      if (key.includes('git switch -c'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git rev-list --count HEAD..origin/main'))
        return { code: 0, stdout: '0\n', stderr: '' }
      return { code: 1, stdout: '', stderr: `unhandled ${key}` }
    }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec,
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    expect(calls).toContainEqual(['git', ['fetch', 'origin']])
    expect(calls).toContainEqual(['git', ['switch', 'main']])
    expect(calls).toContainEqual(['git', ['pull', '--ff-only']])
    expect(calls).toContainEqual([
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'headRefName',
        '-q',
        '.[].headRefName',
      ],
    ])
    expect(calls).toContainEqual(['git', ['branch', '-r']])
    expect(calls).toContainEqual([
      'pnpm',
      ['-s', 'roadmap', 'next', '--json', '--skip', 'skip-me,remote-a'],
    ])
    expect(calls).toContainEqual(['git', ['switch', '-c', 'feat/argv-item']])
    expect(calls.some(([file]) => file === 'openspec')).toBe(false)
    expect(
      fs.existsSync(
        path.join(root, 'openspec', 'changes', 'argv-item', '.openspec.yaml'),
      ),
    ).toBe(true)
    expect(JSON.parse(r.out).skips).toEqual(['skip-me', 'remote-a'])
  })

  it('preflight --slug branches from origin/main without switching main', () => {
    const root = tmpRoot()
    const item = {
      slug: 'slug-item',
      tag: 'prep',
      title: 't',
      file: 'f',
      milestone: 'M2.1',
      goal: ['g'],
    }
    const calls = []
    const exec = fakeExec([
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git fetch origin', { code: 0 }],
      ['gh pr list', { stdout: '' }],
      ['git branch -r', { stdout: '' }],
      [
        'pnpm -s roadmap next --json --slug slug-item',
        { stdout: JSON.stringify(item) },
      ],
      ['git switch -c feat/slug-item --no-track origin/main', { code: 0 }],
      ['openspec new change', { code: 0 }],
      [
        'openspec instructions proposal',
        { stdout: JSON.stringify({ template: 'T', rules: ['r'] }) },
      ],
    ])
    const wrapped = (file, args, opts) => {
      calls.push([file, [...args]])
      return exec(file, args, opts)
    }
    const r = run(
      ['preflight', '--slug', 'slug-item', '--json', '--root', root],
      {
        cwd: root,
        exec: wrapped,
        env: {},
      },
    )
    expect(r.code, r.err).toBe(0)
    expect(
      calls.some(
        (c) => c[0] === 'git' && c[1][0] === 'switch' && c[1][1] === 'main',
      ),
    ).toBe(false)
    expect(calls).toContainEqual([
      'git',
      ['switch', '-c', 'feat/slug-item', '--no-track', 'origin/main'],
    ])
    expect(JSON.parse(r.out).item.slug).toBe('slug-item')
    const fetchIdx = calls.findIndex(
      (c) => c[0] === 'git' && c[1][0] === 'fetch' && c[1][1] === 'origin',
    )
    const behindIdx = calls.findIndex(
      (c) =>
        c[0] === 'git' &&
        c[1].join(' ') === 'rev-list --count HEAD..origin/main',
    )
    expect(fetchIdx).toBeGreaterThanOrEqual(0)
    expect(behindIdx).toBeGreaterThan(fetchIdx)
  })

  it('flags stale branch behind origin/main without merging when ahead', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'stale-item'), {
      recursive: true,
    })
    const item = {
      slug: 'stale-item',
      tag: 'prep',
      title: 't',
      file: 'f',
      milestone: 'M',
      goal: ['g'],
      body: 'b',
    }
    let merged = false
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/stale-item', { code: 0 }],
        ['git rev-list --count HEAD..origin/main', { stdout: '2\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '1\n' }],
        [
          'git merge origin/main',
          () => {
            merged = true
            return { code: 0, stdout: '', stderr: '' }
          },
        ],
        [
          'openspec instructions proposal',
          {
            stdout: JSON.stringify({ template: '# T', rules: ['r'] }),
          },
        ],
      ]),
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.stale).toBe(true)
    expect(j.staleWarning).toMatch(/behind origin\/main/)
    expect(j.staleWarning).toMatch(/not merging/)
    expect(merged).toBe(false)

    const text = run(['preflight', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/stale-item', { code: 0 }],
        ['git rev-list --count HEAD..origin/main', { stdout: '2\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '1\n' }],
        [
          'openspec instructions proposal',
          { stdout: JSON.stringify({ template: '# T', rules: ['r'] }) },
        ],
      ]),
      env: {},
    })
    expect(text.code, text.err).toBe(0)
    expect(text.out).toMatch(/staleWarning:.*behind origin\/main/)
    expect(text.out).toMatch(/not merging/)
  })

  it('emits checklist ids when quality/review-checklist.md exists', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'quality'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'quality/review-checklist.md'),
      '# Review\n\n- `scope`: stay in touch-set\n- size: under budget\n- [ ] `gates`: do not weaken\n',
    )
    expect(readReviewChecklistIds(root)).toEqual(['scope', 'size', 'gates'])
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'demo-item'), {
      recursive: true,
    })
    const item = {
      slug: 'demo-item',
      tag: 'prep',
      title: 't',
      file: 'f',
      milestone: 'M',
      goal: ['g'],
      body: 'b',
    }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 0 }],
        [
          'openspec instructions proposal',
          { stdout: JSON.stringify({ template: '# T', rules: [] }) },
        ],
      ]),
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(r.out).checklistIds).toEqual(['scope', 'size', 'gates'])

    const text = run(['preflight', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 0 }],
        [
          'openspec instructions proposal',
          { stdout: JSON.stringify({ template: '# T', rules: [] }) },
        ],
      ]),
      env: {},
    })
    expect(text.code, text.err).toBe(0)
    expect(text.out).toContain('checklistIds: scope,size,gates')
    expect(text.out).not.toContain('staleWarning:')
  })
})

describe('readReviewChecklistIds', () => {
  it('returns [] when the checklist file is missing', () => {
    expect(readReviewChecklistIds(tmpRoot())).toEqual([])
  })

  it('returns [] when readFile throws', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'quality'), { recursive: true })
    fs.writeFileSync(path.join(root, 'quality/review-checklist.md'), 'x')
    expect(
      readReviewChecklistIds(root, () => {
        throw new Error('EACCES')
      }),
    ).toEqual([])
  })

  it('parses both id regex forms and dedupes', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'quality'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'quality/review-checklist.md'),
      [
        '- `scope`: touch-set',
        '- size: under budget',
        '- [ ] `gates`: do not weaken',
        '- `scope`: duplicate ignored',
        '- [x] evidence: must be real',
      ].join('\n'),
    )
    expect(readReviewChecklistIds(root)).toEqual([
      'scope',
      'size',
      'gates',
      'evidence',
    ])
  })
})

describe('summarizePushFailure / refreshStaleFeatureBranch', () => {
  it('prefers compact check lines from push output', () => {
    expect(
      summarizePushFailure(
        'OK typecheck (0.1s)\nlint: a.ts:1 err\nbanner junk\nfull log: .cache/checks/lint.log\n… +3 more, full log: x\n',
        'hook failed\n',
      ),
    ).toBe(
      [
        'OK typecheck (0.1s)',
        'lint: a.ts:1 err',
        'full log: .cache/checks/lint.log',
        '… +3 more, full log: x',
      ].join('\n'),
    )
    expect(
      summarizePushFailure('\u001b[32mOK typecheck (0.2s)\u001b[0m\n', ''),
    ).toBe('OK typecheck (0.2s)')
    expect(summarizePushFailure(null, undefined)).toBe('(no output)')
    expect(summarizePushFailure(undefined, null)).toBe('(no output)')
  })

  it('falls back to tailOutput when no check-ish lines', () => {
    const summary = summarizePushFailure(
      'random\nnoise\n',
      'fatal: remote rejected\n',
    )
    expect(summary).toContain('fatal: remote rejected')
    expect(summary).not.toMatch(/^OK /)
  })

  it('caps check-ish lines at 60', () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `lint: f.ts:${i} err`,
    ).join('\n')
    const summary = summarizePushFailure(many, '')
    expect(summary.split('\n')).toHaveLength(60)
  })

  it('accepts OK/check prefixes and rejects near-misses', () => {
    expect(summarizePushFailure('OK typecheck (1.0s)\n', '')).toBe(
      'OK typecheck (1.0s)',
    )
    expect(
      summarizePushFailure('OKAY typecheck (1.0s)\n', 'tail-only\n'),
    ).toContain('tail-only')
    expect(summarizePushFailure('Lint: no\n', 'x\n')).toContain('x')
    expect(summarizePushFailure('… +2 more, full log: z\n', '')).toBe(
      '… +2 more, full log: z',
    )
    expect(summarizePushFailure('full log: .cache/checks/a.log\n', '')).toBe(
      'full log: .cache/checks/a.log',
    )
    expect(summarizePushFailure('  padded\nOK unit (0.1s)\n', '')).toBe(
      'OK unit (0.1s)',
    )
  })

  it('refreshStaleFeatureBranch no-ops when not behind', () => {
    const r = refreshStaleFeatureBranch(
      fakeExec([['git rev-list --count HEAD..origin/main', { stdout: '0\n' }]]),
      '/tmp',
      '/tmp',
      {},
      true,
    )
    expect(r).toEqual({
      stale: false,
      warning: null,
      merged: false,
      action: null,
    })
  })

  it('refreshStaleFeatureBranch treats behind=1 as stale (not <=1 no-op)', () => {
    let ff = false
    const r = refreshStaleFeatureBranch(
      fakeExec([
        ['git rev-list --count HEAD..origin/main', { stdout: '1\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '0\n' }],
        [
          'git merge --ff-only origin/main',
          () => {
            ff = true
            return { code: 0 }
          },
        ],
      ]),
      '/tmp',
      '/tmp',
      {},
      true,
    )
    expect(ff).toBe(true)
    expect(r.stale).toBe(true)
    expect(r.warning).toMatch(/by 1 commit/)
  })

  it('refreshStaleFeatureBranch names empty non-numeric counts', () => {
    expect(() =>
      refreshStaleFeatureBranch(
        fakeExec([
          ['git rev-list --count HEAD..origin/main', { stdout: '   \n' }],
        ]),
        '/tmp',
        '/tmp',
        {},
        true,
      ),
    ).toThrow(/\(empty\)/)
  })

  it('refreshStaleFeatureBranch fails on non-numeric behind', () => {
    expect(() =>
      refreshStaleFeatureBranch(
        fakeExec([
          ['git rev-list --count HEAD..origin/main', { stdout: 'NaN\n' }],
        ]),
        '/tmp',
        '/tmp',
        {},
        true,
      ),
    ).toThrow(/non-numeric count/)
  })

  it('refreshStaleFeatureBranch fails on non-numeric ahead', () => {
    expect(() =>
      refreshStaleFeatureBranch(
        fakeExec([
          ['git rev-list --count HEAD..origin/main', { stdout: '2\n' }],
          ['git rev-list --count origin/main..HEAD', { stdout: 'oops\n' }],
        ]),
        '/tmp',
        '/tmp',
        {},
        true,
      ),
    ).toThrow(/non-numeric count/)
  })

  it('refreshStaleFeatureBranch fails on empty ahead stdout', () => {
    expect(() =>
      refreshStaleFeatureBranch(
        fakeExec([
          ['git rev-list --count HEAD..origin/main', { stdout: '2\n' }],
          ['git rev-list --count origin/main..HEAD', { stdout: '\n' }],
        ]),
        '/tmp',
        '/tmp',
        {},
        true,
      ),
    ).toThrow(/\(empty\)/)
  })

  it('refreshStaleFeatureBranch recreates via ff-only when ahead is 0', () => {
    let ff = false
    const r = refreshStaleFeatureBranch(
      fakeExec([
        ['git rev-list --count HEAD..origin/main', { stdout: '3\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '0\n' }],
        [
          'git merge --ff-only origin/main',
          () => {
            ff = true
            return { code: 0, stdout: '', stderr: '' }
          },
        ],
      ]),
      '/tmp',
      '/tmp',
      {},
      true,
    )
    expect(ff).toBe(true)
    expect(r.action).toBe('recreate-ff')
    expect(r.stale).toBe(true)
    expect(r.warning).toMatch(/recreating/)
  })

  it('refreshStaleFeatureBranch warns without merging when ahead > 0', () => {
    let merged = false
    const r = refreshStaleFeatureBranch(
      fakeExec([
        ['git rev-list --count HEAD..origin/main', { stdout: '2\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '4\n' }],
        [
          'git merge origin/main',
          () => {
            merged = true
            return { code: 0, stdout: '', stderr: '' }
          },
        ],
      ]),
      '/tmp',
      '/tmp',
      {},
      true,
    )
    expect(merged).toBe(false)
    expect(r.merged).toBe(false)
    expect(r.action).toBe(null)
    expect(r.stale).toBe(true)
    expect(r.warning).toMatch(/not merging/)
  })
})

describe('finish', () => {
  function finishBase(extra = []) {
    return fakeExec([
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git branch --show-current', { stdout: 'feat/demo\n' }],
      ['git rev-list --count origin/main..HEAD', { stdout: '2\n' }],
      ...extra,
    ])
  }

  it('refuses dirty tree', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '?? x\n' }],
      ]),
      env: {},
    })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe(
      'working tree not clean (commit first):\n?? x',
    )
  })

  it('refuses main', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'main\n' }],
      ]),
      env: {},
    })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe(
      'finish refuses branch "main" (need feat/* or fix/* with commits ahead of origin/main)',
    )
  })

  it('refuses zero commits ahead', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'feat/demo\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '0\n' }],
      ]),
      env: {},
    })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe(
      'finish refuses: no commits ahead of origin/main (ahead=0)',
    )
  })

  it('refuses NaN ahead count', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'feat/demo\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: 'NaN\n' }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toBe(
      'finish refuses: no commits ahead of origin/main (ahead=NaN)',
    )
  })

  it('refuses empty ahead stdout using 0 fallback in message', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'feat/demo\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '  \n' }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toBe(
      'finish refuses: no commits ahead of origin/main (ahead=0)',
    )
  })

  it('text mode push failure omits checks lines', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'feat/demo\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '2\n' }],
        ['git push', { code: 1, stderr: 'denied\n' }],
      ]),
      env: {},
    })
    expect(r.code).toBe(1)
    expect(r.out).toBe(
      [
        'ok: false',
        'stage: push',
        'pushAttempts: 1',
        'branch: feat/demo',
        'ahead: 2',
        'pr: undefined',
        'created: undefined',
        'stampCurrent: false',
        'summary: warning: stage-11 green-tree stamp missing or stale (finish is thin; pre-push still runs A+C1 unless stamp matches); denied',
      ].join('\n'),
    )
  })

  it('pre-push check failure surfaces compact problem lines', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'feat/demo\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '1\n' }],
        [
          'git push',
          {
            code: 1,
            stdout: 'lint: src/a.ts:1 error expected 1 to be 2\n',
            stderr: 'hook failed\n',
          },
        ],
      ]),
      env: {},
    })
    expect(r.code).toBe(1)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(false)
    expect(j.summary).toContain('lint: src/a.ts:1 error expected 1 to be 2')
    expect(j.summary).not.toContain('--no-verify')
  })

  it('finish never passes --no-verify and does not pre-run verify', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    const calls = []
    /** @type {NodeJS.ProcessEnv | undefined} */
    let pushEnv
    const base = finishBase([
      ['git push', { code: 0 }],
      [
        'gh pr list --head',
        {
          stdout: JSON.stringify({
            number: 1,
            url: 'https://example.com/pr/1',
          }),
        },
      ],
    ])
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: (file, args, opts) => {
          calls.push([file, [...args]])
          if (file === 'git' && args[0] === 'push') pushEnv = opts?.env
          return base(file, args, opts)
        },
        env: {},
      },
    )
    expect(r.code, r.err).toBe(0)
    expect(
      calls.some(
        (c) =>
          c[0] === 'pnpm' &&
          (c[1].includes('verify:fast:quiet') ||
            c[1].includes('check') ||
            c[1].includes('quality:self-check')),
      ),
    ).toBe(false)
    expect(calls.some((c) => c[1].includes('--no-verify'))).toBe(false)
    expect(
      calls.some(
        (c) =>
          c[0] === 'git' &&
          c[1].includes('merge') &&
          c[1].includes('origin/main'),
      ),
    ).toBe(false)
    expect(pushEnv?.AGENT_THIN_FINISH).toBe('1')
    const j = JSON.parse(r.out)
    expect(j.stampCurrent).toBe(false)
    expect(j.summary).toContain('stage-11 green-tree stamp missing or stale')
  })

  it('finish skips ritual messaging when green-tree stamp is current', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          [
            'gh pr list --head',
            {
              stdout: JSON.stringify({
                number: 1,
                url: 'https://example.com/pr/1',
              }),
            },
          ],
        ]),
        env: {},
        isGreenTreeStampCurrent: () => true,
      },
    )
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.stampCurrent).toBe(true)
    expect(j.summary).toContain('A/C1/C2 ritual already stamped')
    expect(j.summary).not.toContain('missing or stale')
  })

  it('stamp-green writes .cache/agent-green-tree', () => {
    const root = gitInitRepo()
    const r = run(['stamp-green', '--json', '--root', root], {
      cwd: root,
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(true)
    expect(j.stamp).toMatch(/^[a-f0-9]{64}$/)
    expect(j.path).toBe(path.join(root, '.cache', 'agent-green-tree'))
    expect(fs.readFileSync(j.path, 'utf8').trim()).toBe(j.stamp)
  })

  it('one push per call and persists budget', () => {
    const root = tmpRoot(true)
    let pushes = 0
    const pushFail = () => {
      pushes++
      return { code: 1, stderr: 'pre-push failed\n' }
    }
    const r1 = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: finishBase([['git push', pushFail]]),
      env: {},
    })
    expect(r1.code).toBe(1)
    expect(JSON.parse(r1.out)).toMatchObject({
      ok: false,
      stage: 'push',
      pushAttempts: 1,
      branch: 'feat/demo',
      ahead: 2,
      stampCurrent: false,
    })
    expect(JSON.parse(r1.out).summary).toContain('pre-push failed')
    expect(JSON.parse(r1.out).summary).toContain(
      'stage-11 green-tree stamp missing or stale',
    )
    expect(pushes).toBe(1)

    const r2 = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: finishBase([['git push', pushFail]]),
      env: {},
    })
    expect(JSON.parse(r2.out).pushAttempts).toBe(2)
    expect(pushes).toBe(2)

    const r3 = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: finishBase([
        [
          'git push',
          () => {
            throw new Error('should not push when budget exhausted')
          },
        ],
      ]),
      env: {},
    })
    expect(JSON.parse(r3.out).summary).toBe(
      'push budget exhausted for feat/demo (2 failed attempts recorded under .git/agent-finish-push-failures.json)',
    )
    expect(pushes).toBe(2)
  })

  it('clears prior push failures after a successful push', () => {
    const root = tmpRoot(true)
    writePushFailures(root, { 'feat/demo': 1, 'feat/other': 2 })
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, '## Summary\n')
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          ['gh pr list --head', { stdout: 'null\n' }],
          ['gh pr create', { stdout: 'https://example.com/pr/clear\n' }],
        ]),
        env: {},
      },
    )
    expect(r.code, r.err).toBe(0)
    expect(readPushFailures(root)).toEqual({ 'feat/other': 2 })
  })

  it('happy path creates PR and does not watch CI', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, '## Summary\n')
    writeRunStarted(root, Date.now() - 5000)
    const calls = []
    const base = finishBase([
      ['git push', { code: 0 }],
      ['gh pr list --head', { stdout: 'null\n' }],
      [
        'gh pr create',
        (file, args) => {
          calls.push([file, [...args]])
          return { stdout: '\u001b[32mhttps://example.com/pr/1\u001b[0m\n' }
        },
      ],
      [
        'gh pr checks --watch',
        () => {
          throw new Error('must not watch CI')
        },
      ],
    ])
    const r = run(
      [
        'finish',
        '--json',
        '--quiet',
        '--root',
        root,
        '--title',
        't',
        '--body-file',
        body,
      ],
      {
        cwd: root,
        exec: base,
        env: { CI: '1' },
      },
    )
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(true)
    expect(j.prUrl).toBe('https://example.com/pr/1')
    expect(j.created).toBe(true)
    expect(j.stage).toBe('pr')
    expect(j.checks).toBeUndefined()
    expect(j.metrics?.wallTimeSec).toBeGreaterThanOrEqual(5)
    const createArgs = calls.find((c) => c[0] === 'gh' && c[1][1] === 'create')
    expect(createArgs).toBeTruthy()
    const bodyFile = createArgs[1][createArgs[1].indexOf('--body-file') + 1]
    expect(fs.readFileSync(bodyFile, 'utf8')).toMatch(/wall_time_sec:/)
    expect(readRunStarted(root)).toBe(null)
  })

  it('updates existing PR without CI watch', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: finishBase([
        ['git push', { code: 0 }],
        [
          'gh pr list --head',
          { stdout: JSON.stringify({ number: 1, url: 'https://pr/1' }) },
        ],
        [
          'gh pr checks --watch',
          () => {
            throw new Error('must not watch CI')
          },
        ],
      ]),
      env: {},
    })
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(true)
    expect(j.created).toBe(false)
    expect(j.prUrl).toBe('https://pr/1')
    expect(j.metrics).toBe(null)
  })

  it('requires --title when creating PR', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root], {
      cwd: root,
      exec: finishBase([
        ['git push', { code: 0 }],
        ['gh pr list --head', { stdout: 'null\n' }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toBe('finish create needs --title')
  })

  it('requires --body-file when creating PR', () => {
    const root = tmpRoot(true)
    const r = run(['finish', '--json', '--root', root, '--title', 't'], {
      cwd: root,
      exec: finishBase([
        ['git push', { code: 0 }],
        ['gh pr list --head', { stdout: 'null\n' }],
      ]),
      env: {},
    })
    expect(JSON.parse(r.err).error).toBe('finish create needs --body-file')
  })

  it('fails when body file is missing', () => {
    const root = tmpRoot(true)
    const missing = path.resolve(root, 'missing.md')
    const r = run(
      [
        'finish',
        '--json',
        '--root',
        root,
        '--title',
        't',
        '--body-file',
        'missing.md',
      ],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          ['gh pr list --head', { stdout: 'null\n' }],
        ]),
        env: {},
      },
    )
    expect(JSON.parse(r.err).error).toBe(`body file missing: ${missing}`)
  })

  it('ignores unparseable existing PR list stdout', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          ['gh pr list --head', { stdout: 'not-json{' }],
          ['gh pr create', { stdout: 'https://example.com/pr/2\n' }],
        ]),
        env: {},
      },
    )
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(r.out).created).toBe(true)
    expect(JSON.parse(r.out).prUrl).toBe('https://example.com/pr/2')
  })

  it('creates PR when gh pr list --head fails', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    let created = false
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          ['gh pr list --head', { code: 1, stderr: 'err\n' }],
          [
            'gh pr create',
            () => {
              created = true
              return { stdout: 'https://example.com/pr/3\n' }
            },
          ],
        ]),
        env: {},
      },
    )
    expect(created).toBe(true)
    expect(JSON.parse(r.out).prUrl).toBe('https://example.com/pr/3')
  })

  it('creates PR when existing list stdout is empty', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          ['gh pr list --head', { stdout: '' }],
          ['gh pr create', { stdout: 'https://example.com/pr/4\n' }],
        ]),
        env: {},
      },
    )
    expect(JSON.parse(r.out).ok).toBe(true)
    expect(JSON.parse(r.out).created).toBe(true)
  })

  it('includes tokens in metrics when AGENT_TOKEN_USAGE is set', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(
      body,
      '## Summary\n\n## Metrics\n\n- wall_time_sec: stale\n',
    )
    writeRunStarted(root, Date.now() - 1000)
    let bodyFile = null
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      {
        cwd: root,
        exec: finishBase([
          ['git push', { code: 0 }],
          ['gh pr list --head', { stdout: 'null\n' }],
          [
            'gh pr create',
            (file, args) => {
              bodyFile = args[args.indexOf('--body-file') + 1]
              return { stdout: 'https://example.com/pr/tok\n' }
            },
          ],
        ]),
        env: { AGENT_TOKEN_USAGE: '12345' },
      },
    )
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.metrics.tokens).toBe('12345')
    const written = fs.readFileSync(bodyFile, 'utf8')
    expect(written).toContain('tokens: 12345')
    expect(written).not.toContain('stale')
  })

  it('records exact argv for push and create without checks watch', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'body-text\n')
    const calls = []
    const exec = (file, args) => {
      calls.push([file, [...args]])
      const key = `${file} ${args.join(' ')}`
      if (key.includes('node -v'))
        return { code: 0, stdout: 'v22.0.0\n', stderr: '' }
      if (key.includes('command -v pnpm'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git status --porcelain'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git branch --show-current'))
        return { code: 0, stdout: 'feat/demo\n', stderr: '' }
      if (key.includes('git rev-list'))
        return { code: 0, stdout: '3\n', stderr: '' }

      if (key.includes('git fetch')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git merge-base --is-ancestor'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git rev-parse --git-path'))
        return {
          code: 0,
          stdout: `.git/${args[args.length - 1]}\n`,
          stderr: '',
        }
      if (key.includes('git push')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('gh pr list'))
        return { code: 0, stdout: 'null\n', stderr: '' }
      if (key.includes('gh pr create'))
        return { code: 0, stdout: 'https://example.com/pr/5\n', stderr: '' }
      return { code: 1, stdout: '', stderr: `unhandled ${key}` }
    }
    const r = run(
      [
        'finish',
        '--json',
        '--root',
        root,
        '--title',
        'My Title',
        '--body-file',
        body,
      ],
      { cwd: root, exec, env: {} },
    )
    expect(r.code, r.err).toBe(0)
    expect(calls).toContainEqual([
      'git',
      ['push', '-q', '-u', 'origin', 'HEAD'],
    ])
    expect(calls).toContainEqual([
      'gh',
      [
        'pr',
        'list',
        '--head',
        'feat/demo',
        '--json',
        'number,url',
        '-q',
        '.[0]',
      ],
    ])
    expect(
      calls.some(
        (c) =>
          c[0] === 'gh' &&
          c[1][0] === 'pr' &&
          c[1][1] === 'create' &&
          c[1].includes('My Title'),
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) =>
          c[0] === 'gh' && c[1].includes('checks') && c[1].includes('--watch'),
      ),
    ).toBe(false)
  })
})

describe('review-brief', () => {
  it('includes untracked touch-set file and outsideTouchSet stat', () => {
    const repo = gitInitRepo()
    const change = path.join(repo, 'openspec', 'changes', 'demo')
    fs.mkdirSync(change, { recursive: true })
    fs.writeFileSync(
      path.join(change, 'design.md'),
      `# Design\n\n## Touch-set\n\n| File | Why |\n| ---- | --- |\n| \`scripts/agent.mjs\` | cli |\n| \`in-touch.txt\` | tracked |\n`,
    )
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, 'scripts', 'agent.mjs'),
      'export const x=1\n',
    )
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'out\n')

    const r = run(
      [
        'review-brief',
        '--json',
        '--root',
        repo,
        '--change',
        'demo',
        '--rules-json',
        '["r"]',
      ],
      { cwd: repo, env: {} },
    )
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.base).toBe('HEAD')
    expect(j.mergeBase).toMatch(/^[0-9a-f]{40}$/)
    expect(j.headDiff).toBeUndefined()
    expect(j.untracked).toEqual(
      expect.arrayContaining(['scripts/agent.mjs', 'outside.txt']),
    )
    expect(j.touchDiff).toMatch(/agent\.mjs/)
    expect(j.inTouchSet).toEqual(['scripts/agent.mjs'])
    expect(j.outsideTouchSet).toEqual(
      expect.arrayContaining(['tracked.txt', 'outside.txt']),
    )
    expect(j.inTouchSet.every((f) => !j.outsideTouchSet.includes(f))).toBe(true)
    expect(j.outsideDiff).toMatch(/tracked\.txt/)
    expect(j.outsideDiff).not.toMatch(/\+changed/)
    expect(j.outsideDiff).toMatch(/\?\? outside\.txt/)
    expect(j.diffStat).toMatch(/\?\?/)
    expect(j.rules).toEqual(['r'])
    expect(j.rulesNote).toBe(null)
  })

  it('uses --base merge-base for committed diffs on a clean tree', () => {
    const repo = gitInitRepo()
    const change = path.join(repo, 'openspec', 'changes', 'demo')
    fs.mkdirSync(change, { recursive: true })
    fs.writeFileSync(
      path.join(change, 'design.md'),
      `| File | Why |\n| ---- | --- |\n| \`tracked.txt\` | t |\n`,
    )
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed-change\n')
    gitExec(['add', 'tracked.txt', 'openspec'], repo)
    gitExec(['commit', '-m', 'change'], repo)
    const headEmpty = run(
      ['review-brief', '--json', '--change', 'demo', '--root', repo],
      { cwd: repo, env: {} },
    )
    expect(JSON.parse(headEmpty.out).touchDiff).toBe('(empty)')

    const withBase = run(
      [
        'review-brief',
        '--json',
        '--change',
        'demo',
        '--root',
        repo,
        '--base',
        'HEAD~1',
      ],
      { cwd: repo, env: {} },
    )
    expect(withBase.code, withBase.err).toBe(0)
    const j = JSON.parse(withBase.out)
    expect(j.base).toBe('HEAD~1')
    expect(j.mergeBase).toMatch(/^[0-9a-f]{40}$/)
    expect(j.touchDiff).toMatch(/committed-change/)
    expect(j.inTouchSet).toEqual(['tracked.txt'])
    expect(j.outsideTouchSet).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/openspec\/changes\/demo\/design\.md/),
      ]),
    )
  })

  it('rejects --base that starts with a dash', () => {
    const repo = gitInitRepo()
    const r = run(
      [
        'review-brief',
        '--json',
        '--change',
        'demo',
        '--root',
        repo,
        '--base',
        '-x',
      ],
      { cwd: repo, env: {} },
    )
    expect(r.code).not.toBe(0)
    expect(JSON.parse(r.err).error).toBe(
      `--base must not start with '-' (got "-x")`,
    )
  })

  it('rejects a bad --base ref', () => {
    const repo = gitInitRepo()
    const r = run(
      [
        'review-brief',
        '--json',
        '--change',
        'demo',
        '--root',
        repo,
        '--base',
        'origin/mian',
      ],
      { cwd: repo, env: {} },
    )
    expect(r.code).not.toBe(0)
    expect(JSON.parse(r.err).error).toMatch(/git merge-base failed/)
  })

  it('fails when merge-base returns empty stdout', () => {
    const root = tmpRoot(true)
    const r = run(
      ['review-brief', '--json', '--change', 'demo', '--root', root],
      {
        cwd: root,
        exec: fakeExec([['git merge-base', { stdout: '  \n' }]]),
        env: {},
      },
    )
    expect(r.code).not.toBe(0)
    expect(JSON.parse(r.err).error).toBe('git merge-base produced empty output')
  })

  it('diff vs merge-base ignores commits that landed only on base', () => {
    const repo = gitInitRepo()
    gitExec(['branch', '-M', 'main'], repo)
    gitExec(['checkout', '-b', 'feat/demo'], repo)
    fs.writeFileSync(path.join(repo, 'branch-only.txt'), 'on-branch\n')
    gitExec(['add', 'branch-only.txt'], repo)
    gitExec(['commit', '-m', 'branch change'], repo)

    gitExec(['checkout', 'main'], repo)
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'on-main\n')
    gitExec(['add', 'main-only.txt'], repo)
    gitExec(['commit', '-m', 'main moved'], repo)

    gitExec(['checkout', 'feat/demo'], repo)
    const change = path.join(repo, 'openspec', 'changes', 'demo')
    fs.mkdirSync(change, { recursive: true })
    fs.writeFileSync(
      path.join(change, 'design.md'),
      `| File | Why |\n| ---- | --- |\n| \`branch-only.txt\` | ours |\n`,
    )

    const tip = run(
      [
        'review-brief',
        '--json',
        '--change',
        'demo',
        '--root',
        repo,
        '--base',
        'main',
      ],
      { cwd: repo, env: {} },
    )
    expect(tip.code, tip.err).toBe(0)
    const j = JSON.parse(tip.out)
    expect(j.inTouchSet).toEqual(['branch-only.txt'])
    expect(j.outsideTouchSet).not.toContain('main-only.txt')
    expect(j.diffStat).not.toMatch(/main-only/)
    expect(j.touchDiff).toMatch(/on-branch/)
  })

  it('rejects invalid --rules-json', () => {
    const root = tmpRoot(true)
    const brief = run(
      ['review-brief', '--json', '--root', root, '--rules-json', '{'],
      {
        cwd: root,
        exec: fakeExec([['git branch --show-current', { stdout: 'feat/z\n' }]]),
        env: {},
      },
    )
    expect(JSON.parse(brief.err).error).toBe('--rules-json must be valid JSON')
  })

  it('notes missing design.md and empty rules', () => {
    const repo = gitInitRepo()
    const b2 = run(['review-brief', '--change', 'missing', '--root', repo], {
      cwd: repo,
      env: {},
    })
    expect(b2.code).toBe(0)
    expect(b2.out).toMatch(
      /^slug: missing\nchangePath: openspec\/changes\/missing\nbase: HEAD\nmergeBase: [0-9a-f]{40}\nrules: \[\]\nrulesNote: pass --rules-json from openspec instructions\nchecklistIds: \n--- diff --stat ---\n/,
    )
    expect(b2.out).toContain(
      'design.md missing; treating all paths as outside touch-set',
    )
    expect(b2.out).toContain('\n--- touch-set diff ---\n(empty)\n')
    expect(b2.out).toContain('\n--- outsideTouchSet ---\n')
    expect(b2.out).toContain('\n--- outsideTouchSet stat ---\n')
  })

  it('lists only-untracked outside with empty touchDiff', () => {
    const repo = gitInitRepo()
    const change = path.join(repo, 'openspec', 'changes', 'demo')
    fs.mkdirSync(change, { recursive: true })
    fs.writeFileSync(
      path.join(change, 'design.md'),
      `| File | Why |\n| ---- | --- |\n| \`does-not-exist-yet.txt\` | future |\n`,
    )
    fs.writeFileSync(path.join(repo, 'only-out.txt'), 'x\n')
    const r = run(
      ['review-brief', '--json', '--change', 'demo', '--root', repo],
      { cwd: repo, env: {} },
    )
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.outsideTouchSet).toContain('only-out.txt')
    expect(j.touchDiff).toBe('(empty)')
    expect(j.outsideDiff).toMatch(/\?\? only-out\.txt/)
  })

  it('records exact git merge-base and diff argv for --base', () => {
    const root = tmpRoot(true)
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'demo'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'openspec', 'changes', 'demo', 'design.md'),
      `| File | Why |\n| ---- | --- |\n| \`a.txt\` | t |\n`,
    )
    const mb = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const calls = []
    const exec = (file, args) => {
      calls.push([file, [...args]])
      const key = `${file} ${args.join(' ')}`
      if (key.includes('git merge-base'))
        return { code: 0, stdout: `${mb}\n`, stderr: '' }
      if (key.includes('git diff') && key.includes('--stat'))
        return { code: 0, stdout: ' 1 file changed\n', stderr: '' }
      if (key.includes('git ls-files'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git diff') && key.includes('--name-only'))
        return { code: 0, stdout: 'a.txt\n', stderr: '' }
      if (key.includes('git diff') && key.includes('-- a.txt'))
        return { code: 0, stdout: 'diff --git a/a.txt\n+hi\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const r = run(
      [
        'review-brief',
        '--json',
        '--root',
        root,
        '--change',
        'demo',
        '--base',
        'origin/main',
        '--rules-json',
        '[]',
      ],
      { cwd: root, exec, env: {} },
    )
    expect(r.code, r.err).toBe(0)
    expect(calls).toContainEqual(['git', ['merge-base', 'origin/main', 'HEAD']])
    expect(calls).toContainEqual(['git', ['diff', mb, '--stat']])
    expect(calls).toContainEqual(['git', ['diff', mb, '--name-only']])
    expect(calls).toContainEqual(['git', ['diff', mb, '--', 'a.txt']])
    expect(calls).toContainEqual([
      'git',
      ['ls-files', '--others', '--exclude-standard'],
    ])
    expect(JSON.parse(r.out).mergeBase).toBe(mb)
    expect(JSON.parse(r.out).touchDiff).toContain('+hi')
  })

  it('fails when --no-index exits outside 0/1', () => {
    expect(() =>
      mustOkDiffNoIndex(
        { code: 2, stdout: '', stderr: 'fatal\n' },
        'git diff --no-index x',
      ),
    ).toThrow(/git diff --no-index x failed \(exit 2\)/)
    expect(
      mustOkDiffNoIndex({ code: 1, stdout: 'diff\n', stderr: '' }, 'ok'),
    ).toEqual({ code: 1, stdout: 'diff\n', stderr: '' })
  })

  it('writes brief to --out path', () => {
    const repo = gitInitRepo()
    const out = path.join(repo, 'brief-out.md')
    const r = run(
      [
        'review-brief',
        '--json',
        '--change',
        'missing',
        '--out',
        out,
        '--rules-json',
        '["r1"]',
      ],
      { cwd: repo, env: {} },
    )
    expect(r.code, r.err).toBe(0)
    expect(fs.existsSync(out)).toBe(true)
    const text = fs.readFileSync(out, 'utf8')
    expect(text).toContain('slug: missing')
    expect(text).toContain('r1')
    expect(JSON.parse(r.out).outPath).toBe(out)
  })
})

describe('instructions', () => {
  it('returns template and rules for an artifact', () => {
    const root = tmpRoot()
    const exec = fakeExec([
      ['git branch --show-current', { stdout: 'feat/demo\n' }],
    ])
    const r = run(['instructions', 'design', '--json', '--root', root], {
      cwd: root,
      exec,
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j).toMatchObject({
      ok: true,
      change: 'demo',
      artifact: 'design',
      template: expect.stringContaining('## Decisions'),
      rules: ['## Decisions + ## Touch-set & Test Plan only.'],
    })
  })
})

describe('archive', () => {
  it('archives change dir from --change and from branch slug', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'arch-item'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'openspec', 'changes', 'arch-item', 'proposal.md'),
      'p\n',
    )
    const r = run(
      ['archive', '--json', '--root', root, '--change', 'arch-item'],
      {
        cwd: root,
        exec: fakeExec([]),
        env: {},
      },
    )
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(true)
    expect(j.archivedTo).toBeNull()
    expect(j.removed).toBe(true)
    expect(j.summary).toContain('removed openspec/changes/arch-item')
    expect(
      fs.existsSync(path.join(root, 'openspec', 'changes', 'arch-item')),
    ).toBe(false)

    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'from-branch'), {
      recursive: true,
    })
    const r2 = run(['archive', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ['git branch --show-current', { stdout: 'feat/from-branch\n' }],
      ]),
      env: {},
    })
    expect(r2.code, r2.err).toBe(0)
    expect(JSON.parse(r2.out).slug).toBe('from-branch')

    const text = run(['archive', '--root', root, '--change', 'missing'], {
      cwd: root,
      exec: fakeExec([]),
      env: {},
    })
    expect(text.code).toBe(0)
    expect(text.out).toContain('no change dir')
  })
})

/** Build a Cursor-shaped store.db: hex meta + blobs root protobuf + JSON messages. */
function writeCursorShapeStoreDb(dbPath, messages, { inflateChars = 0 } = {}) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const digests = messages.map((_, i) => {
    const d = Buffer.alloc(32, i + 1)
    d[31] = i
    return d
  })
  const rootId = Buffer.alloc(32, 0xaa).toString('hex')
  const rootParts = []
  for (const d of digests) {
    rootParts.push(Buffer.from([0x0a, 0x20]), d)
  }
  // optional other field to exercise non-field-1 skip (field 5 varint)
  rootParts.push(Buffer.from([0x28, 0x01]))
  const rootBlob = Buffer.concat(rootParts)
  const metaObj = {
    agentId: 'test-agent',
    latestRootBlobId: rootId,
    name: 'Test',
    mode: 'default',
    isRunEverything: true,
    createdAt: 1,
    blobEncryptionKey: '00'.repeat(32),
  }
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    '0',
    Buffer.from(JSON.stringify(metaObj), 'utf8').toString('hex'),
  )
  db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(rootId, rootBlob)
  messages.forEach((msg, i) => {
    const body = { ...msg }
    if (inflateChars > 0 && i === 0) {
      if (typeof body.content === 'string') {
        body.content = body.content + 'x'.repeat(inflateChars)
      } else {
        body.content = 'x'.repeat(inflateChars)
      }
    }
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      digests[i].toString('hex'),
      Buffer.from(JSON.stringify(body), 'utf8'),
    )
  })
  db.close()
  return { rootId, digests }
}

describe('stats', () => {
  it('prints metrics and exits 0 under thresholds', () => {
    const root = tmpRoot()
    const file = path.join(root, 'ok.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        rounds: [
          {
            input: 1000,
            output: 200,
            cacheRead: 50,
            modelCalls: 1,
            context: 1200,
          },
          {
            input: 1500,
            output: 300,
            cacheRead: 80,
            modelCalls: 2,
            context: 1800,
          },
        ],
      }),
    )
    const r = run(['stats', file, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.peakContext).toBe(1800)
    expect(j.firstInput).toBe(1000)
    expect(j.modelCalls).toBe(3)
    expect(j.rounds).toHaveLength(2)
  })

  it('accepts JSONL rounds documents', () => {
    const root = tmpRoot()
    const file = path.join(root, 'rounds.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          input: 11,
          output: 2,
          cacheRead: 1,
          modelCalls: 1,
          context: 15,
        }),
        JSON.stringify({
          input: 20,
          output: 3,
          cacheRead: 0,
          modelCalls: 1,
          context: 25,
        }),
      ].join('\n') + '\n',
    )
    const r = run(['stats', file, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.peakContext).toBe(25)
    expect(j.rounds).toHaveLength(2)
  })

  it('parses cursor-agent -p --output-format json usage', () => {
    const root = tmpRoot()
    const file = path.join(root, 'agent-result.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: {
          inputTokens: 232162,
          outputTokens: 56110,
          cacheReadTokens: 7817216,
          cacheWriteTokens: 0,
        },
      }),
    )
    const r = run(['stats', file, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.firstInput).toBe(232162)
    expect(j.rounds[0]).toMatchObject({
      input: 232162,
      output: 56110,
      cacheRead: 7817216,
      modelCalls: 1,
      context: 232162,
      estimated: false,
    })
    expect(j.estimated).toBe(false)
  })

  it('parses JSONL of cursor-agent usage results', () => {
    const root = tmpRoot()
    const file = path.join(root, 'results.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'result',
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 1,
          },
        }),
        JSON.stringify({
          type: 'result',
          usage: {
            inputTokens: 200,
            outputTokens: 20,
            cacheReadTokens: 2,
          },
        }),
      ].join('\n'),
    )
    const r = run(['stats', file, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.rounds).toHaveLength(2)
    expect(j.peakContext).toBe(200)
    expect(j.firstInput).toBe(100)
  })

  it('exits 1 when peak context exceeds 300K', () => {
    const root = tmpRoot()
    const file = path.join(root, 'over-peak.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        rounds: [
          {
            input: 100,
            output: 10,
            cacheRead: 0,
            modelCalls: 1,
            context: 300_001,
          },
        ],
      }),
    )
    const r = run(['stats', file], { cwd: root, env: {} })
    expect(r.code).toBe(1)
    expect(r.out).toContain('peakContext: 300001')
  })

  it('exits 1 when first-round input exceeds 400K', () => {
    const root = tmpRoot()
    const file = path.join(root, 'over-first.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        rounds: [
          {
            input: 400_001,
            output: 10,
            cacheRead: 0,
            modelCalls: 1,
            context: 1000,
          },
        ],
      }),
    )
    const r = run(['stats', file, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).firstInput).toBe(400_001)
  })

  it('reads agentStats.rounds from store.db meta', () => {
    const root = tmpRoot()
    const dbPath = path.join(root, 'store.db')
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      JSON.stringify({
        agentStats: {
          rounds: [
            {
              input: 10,
              output: 2,
              cacheRead: 1,
              modelCalls: 1,
              context: 20,
            },
          ],
        },
      }),
    )
    db.close()
    const r = run(['stats', dbPath, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).peakContext).toBe(20)
  })

  it('estimates rounds from a real-shaped Cursor store.db', () => {
    const root = tmpRoot()
    const dbPath = path.join(root, 'cursor-store.db')
    writeCursorShapeStoreDb(dbPath, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<user_info>\nOS: test\n' },
      { role: 'user', content: 'hello-user' },
      { role: 'assistant', content: 'hello-asst' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply2' },
      { role: 'tool', content: [{ type: 'tool-result', result: 'ok' }] },
    ])
    const r = run(['stats', dbPath], { cwd: root, env: {} })
    expect(r.code).toBe(0)
    expect(r.out).toContain('estimated=true')
    expect(r.out).toContain('content chars/3.3')
    const j = JSON.parse(
      run(['stats', dbPath, '--json'], { cwd: root, env: {} }).out,
    )
    expect(j.estimated).toBe(true)
    expect(j.rounds).toHaveLength(2)
    expect(j.rounds[0].modelCalls).toBe(1)
    expect(j.rounds[0].estimated).toBe(true)
    expect(j.peakContext).toBeGreaterThan(0)
  })

  it('ignores system_notification users and reasoning signatures in store.db peak', () => {
    const root = tmpRoot()
    const dbPath = path.join(root, 'notif-store.db')
    const hugeSig = 'S'.repeat(50_000)
    writeCursorShapeStoreDb(dbPath, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<user_info>\nworkspace\n' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'first prompt' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'plan',
            signature: hugeSig,
            providerOptions: { cursor: { x: 1 } },
          },
          { type: 'text', text: 'answer1' },
          {
            type: 'tool-call',
            toolName: 'Shell',
            args: { command: 'true' },
            toolCallId: 'c1',
          },
        ],
        id: 'msg-1',
        providerOptions: { cursor: { modelProviderMessageId: 'm1' } },
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'Shell',
            result: 'ok',
            toolCallId: 'c1',
            experimental_content: [{ type: 'text', text: 'ignored-meta' }],
          },
        ],
      },
      {
        role: 'user',
        content:
          '<timestamp>t</timestamp>\n<system_notification>\nThe following task has finished.\n</system_notification>',
      },
      {
        role: 'user',
        content:
          '<timestamp>t2</timestamp>\n<system_notification>\ntask 2 done\n</system_notification>',
      },
      { role: 'user', content: 'second prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', signature: hugeSig },
          { type: 'text', text: 'answer2' },
        ],
      },
    ])
    const j = JSON.parse(
      run(['stats', dbPath, '--json'], { cwd: root, env: {} }).out,
    )
    expect(j.rounds).toHaveLength(2)
    expect(j.rounds[0].modelCalls).toBe(1)
    expect(j.rounds[1].modelCalls).toBe(1)
    expect(j.peakContext).toBeLessThan(5_000)
    const asst = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'plan', signature: hugeSig },
        { type: 'text', text: 'answer1' },
      ],
    }
    expect(messageContentChars(asst)).toBe('plan'.length + 'answer1'.length)
    expect(messageContentChars(asst)).toBeLessThan(hugeSig.length)
  })

  it('exits 1 on real-shaped store.db whose estimated peak exceeds 300K', () => {
    const root = tmpRoot()
    const dbPath = path.join(root, 'huge-store.db')
    writeCursorShapeStoreDb(
      dbPath,
      [
        { role: 'system', content: 's' },
        { role: 'user', content: '<user_info>\nx\n' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ],
      { inflateChars: 1_050_000 },
    )
    const r = run(['stats', dbPath, '--json'], { cwd: root, env: {} })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).peakContext).toBeGreaterThan(300_000)
  })

  it('blobIdsFromRootProtobuf extracts field-1 digests and skips other fields', () => {
    const id = Buffer.alloc(32, 0x42)
    const rootBuf = Buffer.concat([
      Buffer.from([0x0a, 0x20]),
      id,
      Buffer.from([0x28, 0x03]),
      Buffer.from([0x12, 0x03, 0x61, 0x62, 0x63]),
      Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8]),
      // field 3 wire type 5 (32-bit) — skip 4 bytes
      Buffer.from([0x1d, 9, 8, 7, 6]),
    ])
    expect(blobIdsFromRootProtobuf(rootBuf)).toEqual([id.toString('hex')])
    expect(() => blobIdsFromRootProtobuf(Buffer.from([0x0b, 0x00]))).toThrow(
      /unsupported protobuf wire type/,
    )
    expect(() => readProtobufVarint(Buffer.from([0x80]), 0)).toThrow(
      /truncated/,
    )
    expect(() => readProtobufVarint(Buffer.alloc(12, 0x80), 0)).toThrow(
      /too long/,
    )
  })

  it('roundsFromStoreMessages skips notifications and user_info preamble', () => {
    expect(
      isUserInfoPreamble({ role: 'user', content: '<user_info>\na' }),
    ).toBe(true)
    expect(
      isSystemNotificationUser({
        role: 'user',
        content: 'x <system_notification> y',
      }),
    ).toBe(false)
    expect(
      isSystemNotificationUser({
        role: 'user',
        content:
          '<timestamp>t</timestamp>\n<system_notification>\ndone\n</system_notification>',
      }),
    ).toBe(true)
    expect(
      isSystemNotificationUser({
        role: 'assistant',
        content: '<system_notification>\nx\n</system_notification>',
      }),
    ).toBe(false)
    expect(isRoundStartingUser({ role: 'user', content: 'go' })).toBe(true)
    const rounds = roundsFromStoreMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: '<user_info>\nOS\n' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      {
        role: 'user',
        content: '<system_notification>\ndone\n</system_notification>',
      },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
    ])
    expect(rounds).toHaveLength(2)
    expect(rounds[0].modelCalls).toBe(1)
    expect(rounds[1].modelCalls).toBe(2)
    expect(rounds.every((x) => x.estimated)).toBe(true)
    expect(() => roundsFromStoreMessages([])).toThrow(/no JSON role/)
    expect(() =>
      roundsFromStoreMessages([{ role: 'system', content: 'only' }]),
    ).toThrow(/no round-starting/)
  })

  it('counts three store.db rounds when a later prompt quotes system_notification', () => {
    const root = tmpRoot()
    const dbPath = path.join(root, 'quoted-notif-store.db')
    writeCursorShapeStoreDb(dbPath, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<user_info>\nOS: test\n' },
      { role: 'user', content: '<cursor_commands>\nround-1 prompt\n' },
      { role: 'assistant', content: 'a1' },
      {
        role: 'user',
        content:
          '<timestamp>t</timestamp>\n<system_notification>\ntask finished\n</system_notification>',
      },
      { role: 'user', content: '<cursor_commands>\nround-2 prompt\n' },
      { role: 'assistant', content: 'a2' },
      {
        role: 'user',
        content:
          '<cursor_commands>\nfix: a prompt that quotes `<system_notification>` in its body must still start a round.\n',
      },
      { role: 'assistant', content: 'a3' },
    ])
    const j = JSON.parse(
      run(['stats', dbPath, '--json'], { cwd: root, env: {} }).out,
    )
    expect(j.rounds).toHaveLength(3)
    expect(j.rounds.every((r) => r.estimated)).toBe(true)
  })

  it('roundFromCursorUsage and parseStatsRoundsJson reject bad inputs', () => {
    expect(() => roundFromCursorUsage(null)).toThrow(/usage object/)
    expect(() =>
      roundFromCursorUsage({ inputTokens: -1, outputTokens: 1 }),
    ).toThrow(/inputTokens/)
    expect(() =>
      roundFromCursorUsage(
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        -2,
      ),
    ).toThrow(/modelCalls/)
    expect(() => parseStatsRoundsJson('')).toThrow(/empty/)
    expect(() => parseStatsRoundsJson('{')).toThrow(/invalid/)
    expect(() => parseStatsRoundsJson('{"no":"usage"}')).toThrow(/must be/)
    expect(() => parseStatsRoundsJson('not-json\n{')).toThrow(/JSONL/)
    expect(() => parseStatsRoundsJson('{"x":1}\n{')).toThrow(/JSONL/)
    expect(() => estimateTokensFromChars(-1)).toThrow(/non-negative/)
    expect(estimateTokensFromChars(STATS_CHARS_PER_TOKEN * 10)).toBe(10)
    expect(
      normalizeRounds([{ inputTokens: 5, outputTokens: 1 }])[0].input,
    ).toBe(5)
    expect(() => normalizeRounds([])).toThrow(/non-empty/)
    expect(() => normalizeRounds([null])).toThrow(/not an object/)
    expect(() =>
      normalizeRounds([{ input: 1, output: 1, context: -1 }]),
    ).toThrow(/invalid context/)
    expect(
      parseStatsRoundsJson(
        JSON.stringify([
          {
            type: 'result',
            usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 1 },
          },
          {
            type: 'result',
            usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 0 },
          },
        ]),
      ),
    ).toHaveLength(2)
    expect(readyArtifactIds(null)).toEqual([])
    expect(
      readyArtifactIds({ artifacts: [{ id: 'a', status: 'done' }] }),
    ).toEqual([])
  })

  it('loadStatsRounds fails loudly on missing path and empty cursor db', () => {
    expect(() => loadStatsRounds('/no/such/stats.json')).toThrow(/not found/)
    const root = tmpRoot()
    const emptyDb = path.join(root, 'empty.db')
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(emptyDb)
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db.close()
    expect(() => loadStatsRounds(emptyDb)).toThrow(/meta is empty/)
    const noRoot = path.join(root, 'noroots.db')
    const db2 = new DatabaseSync(noRoot)
    db2.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db2.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db2
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(
        '0',
        Buffer.from(JSON.stringify({ agentId: 'x' }), 'utf8').toString('hex'),
      )
    db2.close()
    expect(() => loadStatsRounds(noRoot)).toThrow(/latestRootBlobId/)

    const missingBlob = path.join(root, 'missing-root-blob.db')
    const db3 = new DatabaseSync(missingBlob)
    db3.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db3.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    const fakeRoot = 'ab'.repeat(32)
    db3
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(
        '0',
        Buffer.from(
          JSON.stringify({ latestRootBlobId: fakeRoot }),
          'utf8',
        ).toString('hex'),
      )
    db3.close()
    expect(() => loadStatsRounds(missingBlob)).toThrow(/missing root blob/)

    const emptyRoot = path.join(root, 'empty-root.db')
    const db4 = new DatabaseSync(emptyRoot)
    db4.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db4.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    const rid = 'cd'.repeat(32)
    db4
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(
        '0',
        Buffer.from(JSON.stringify({ latestRootBlobId: rid }), 'utf8').toString(
          'hex',
        ),
      )
    db4
      .prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
      .run(rid, Buffer.from([0x28, 0x01]))
    db4.close()
    expect(() => loadStatsRounds(emptyRoot)).toThrow(/no field-1/)

    const plain = path.join(root, 'plain-meta.db')
    const db5 = new DatabaseSync(plain)
    db5.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB)')
    db5.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db5.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({
          rounds: [
            {
              input: 3,
              output: 1,
              cacheRead: 0,
              modelCalls: 1,
              context: 3,
            },
          ],
        }),
        'utf8',
      ),
    )
    db5.close()
    expect(loadStatsRounds(plain)[0].input).toBe(3)

    const badJsonBlob = path.join(root, 'bad-json-blob.db')
    writeCursorShapeStoreDb(badJsonBlob, [
      { role: 'system', content: 's' },
      { role: 'user', content: '<user_info>\n' },
      { role: 'user', content: 'go' },
    ])
    const db6 = new DatabaseSync(badJsonBlob)
    const rows = db6.prepare('SELECT id, data FROM blobs').all()
    const msg = rows.find((r) => Buffer.from(r.data)[0] === 0x7b)
    expect(msg).toBeTruthy()
    db6
      .prepare('UPDATE blobs SET data = ? WHERE id = ?')
      .run(Buffer.from('{not-json', 'utf8'), msg.id)
    db6.close()
    expect(() => loadStatsRounds(badJsonBlob)).toThrow(/not valid JSON/)

    const hexInBuffer = path.join(root, 'hex-in-buffer-meta.db')
    const db7 = new DatabaseSync(hexInBuffer)
    db7.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB)')
    db7.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    const roundsPayload = {
      rounds: [
        {
          input: 4,
          output: 1,
          cacheRead: 0,
          modelCalls: 1,
          context: 4,
        },
      ],
    }
    db7
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(
        '0',
        Buffer.from(
          Buffer.from(JSON.stringify(roundsPayload), 'utf8').toString('hex'),
          'utf8',
        ),
      )
    db7.close()
    expect(loadStatsRounds(hexInBuffer)[0].input).toBe(4)

    const badHexJson = path.join(root, 'bad-hex-json-meta.db')
    const db8 = new DatabaseSync(badHexJson)
    db8.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB)')
    db8.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db8
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(
        '0',
        Buffer.from(Buffer.from('{nope', 'utf8').toString('hex'), 'utf8'),
      )
    db8.close()
    expect(() => loadStatsRounds(badHexJson)).toThrow(/latestRootBlobId/)

    const nonHexBuf = path.join(root, 'non-hex-buf-meta.db')
    const db9 = new DatabaseSync(nonHexBuf)
    db9.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB)')
    db9.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db9
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('0', Buffer.from('{not-json-or-hex', 'utf8'))
    db9.close()
    expect(() => loadStatsRounds(nonHexBuf)).toThrow(/latestRootBlobId/)

    const badHexString = path.join(root, 'bad-hex-string-meta.db')
    const db10 = new DatabaseSync(badHexString)
    db10.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db10.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db10
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('0', Buffer.from('{nope', 'utf8').toString('hex'))
    db10.close()
    expect(() => loadStatsRounds(badHexString)).toThrow(/latestRootBlobId/)

    const junkString = path.join(root, 'junk-string-meta.db')
    const db11 = new DatabaseSync(junkString)
    db11.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db11.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db11
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('0', 'not-json-and-NOT-hex!!')
    db11.close()
    expect(() => loadStatsRounds(junkString)).toThrow(/latestRootBlobId/)
  })

  it('parseStatsRoundsJson covers array normalize and non-JSONL rejection', () => {
    expect(
      parseStatsRoundsJson(
        JSON.stringify([
          {
            input: 1,
            output: 1,
            cacheRead: 0,
            modelCalls: 1,
            context: 1,
          },
          {
            input: 2,
            output: 1,
            cacheRead: 0,
            modelCalls: 1,
            context: 2,
          },
        ]),
      ),
    ).toHaveLength(2)
    expect(() =>
      parseStatsRoundsJson(
        'true\n{"input":1,"output":1,"cacheRead":0,"modelCalls":1,"context":1}',
      ),
    ).toThrow(/must be JSON/)
    const circ = {
      role: 'assistant',
      content: [{ type: 'tool-call', args: {} }],
    }
    circ.content[0].args.self = circ.content[0].args
    expect(messageContentChars(circ)).toBe(0)
  })

  it('native status unlocks design after proposal.md exists', () => {
    const root = tmpRoot()
    const changeDir = path.join(root, 'openspec', 'changes', 'demo-item')
    fs.mkdirSync(changeDir, { recursive: true })
    fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## Proposal\n')
    const item = { slug: 'demo-item', tag: 'prep', title: 't', file: 'f' }
    const r = run(['preflight', '--json', '--root', root], {
      cwd: root,
      exec: fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git fetch origin', { code: 0 }],
        ['git switch main', { code: 0 }],
        ['git pull --ff-only', { code: 0 }],
        ['gh pr list', { stdout: '' }],
        ['git branch -r', { stdout: '' }],
        ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
        ['git switch -c feat/demo-item', { code: 0 }],
      ]),
      env: {},
    })
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.runCard.ready).toEqual(expect.arrayContaining(['design', 'specs']))
    expect(j.runCard.ready).not.toContain('proposal')
  })

  it('instructions text mode and stats usage without path error branches', () => {
    const root = tmpRoot()
    const exec = fakeExec([
      ['git branch --show-current', { stdout: 'feat/demo\n' }],
    ])
    const r = run(['instructions', 'proposal', '--root', root], {
      cwd: root,
      exec,
      env: {},
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('--- template ---')
    expect(r.out).toContain('## Proposal')
    expect(r.out).toContain('- Keep proposals under 80 words.')
    const missing = run(['stats'], { cwd: root, env: {} })
    expect(missing.code).toBe(2)
    expect(missing.err).toMatch(/usage: pnpm agent stats/)
    const noArt = run(['instructions'], { cwd: root, env: {} })
    expect(noArt.code).toBe(2)
  })

  it('text preflight prints run-card branches from native status', () => {
    const root = tmpRoot()
    const item = {
      slug: 'card-item',
      tag: 'prep',
      title: 't',
      file: 'f',
      milestone: 'M',
      goal: ['g'],
    }
    const exec = fakeExec([
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git fetch origin', { code: 0 }],
      ['git switch main', { code: 0 }],
      ['git pull --ff-only', { code: 0 }],
      ['gh pr list', { stdout: '' }],
      ['git branch -r', { stdout: '' }],
      ['pnpm -s roadmap next --json', { stdout: JSON.stringify(item) }],
      ['git switch -c feat/card-item', { code: 0 }],
    ])
    const r = run(['preflight', '--root', root], { cwd: root, exec, env: {} })
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('runCard.ready: proposal')
    expect(r.out).toContain('--- runCard artifact: proposal (rules=1) ---')
    expect(r.out).toContain('--- apply/archive procedure ---')
  })
})

describe('help / errors / defaultExec / main', () => {
  it('help output contains usage contract', () => {
    const h = run(['help'])
    expect(h.code).toBe(0)
    for (const s of HELP_SNIPPETS) expect(h.out).toContain(s)
    expect(run(['--help']).code).toBe(0)
    expect(run([]).code).toBe(2)
    expect(run([]).out).toContain('usage: pnpm agent')
  })

  it('unknown command includes HELP', () => {
    const u = run(['nope', '--json'])
    expect(u.code).toBe(2)
    const err = JSON.parse(u.err).error
    expect(err.startsWith('unknown command: nope\n')).toBe(true)
    expect(err).toContain('usage: pnpm agent')
  })

  it('rejects unexpected positional args', () => {
    const extra = run(['preflight', 'extra', '--json'])
    expect(extra.code).toBe(2)
    expect(JSON.parse(extra.err).error).toBe('unexpected argument: extra')
  })

  it('defaultExec success exit and signal paths', () => {
    const ok = defaultExec('node', ['-e', 'process.stdout.write("hi")'])
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: '' })
    const bad = defaultExec('node', ['-e', 'process.exit(3)'])
    expect(bad.code).toBe(3)
    const withErr = defaultExec('node', [
      '-e',
      'process.stderr.write("e"); process.exit(2)',
    ])
    expect(withErr).toEqual({ code: 2, stdout: '', stderr: 'e' })
    const signaled = defaultExec('node', [
      '-e',
      'process.kill(process.pid,"SIGTERM")',
    ])
    expect(signaled.code).toBe(1)
  })

  it('defaultExec surfaces spawn ENOENT via message fallback', () => {
    const missing = defaultExec('definitely-not-a-binary-photobooks-xyz', [
      '--help',
    ])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toMatch(/ENOENT|not found|spawn/i)
    expect(missing.stderr).not.toBe('null')
  })

  it('main writes stdout stderr with trailing newlines', () => {
    const io = {
      stdout: {
        buf: '',
        write(s) {
          this.buf += s
        },
      },
      stderr: {
        buf: '',
        write(s) {
          this.buf += s
        },
      },
      exitCode: 0,
    }
    main(['help'], io)
    expect(io.stdout.buf.endsWith('\n')).toBe(true)
    expect(io.stdout.buf.slice(0, -1)).toContain('usage: pnpm agent')
    expect(io.stderr.buf).toBe('')
    expect(io.exitCode).toBe(0)

    io.stdout.buf = ''
    io.stderr.buf = ''
    main(['nope'], io)
    expect(io.stdout.buf).toBe('')
    expect(io.stderr.buf.endsWith('\n')).toBe(true)
    expect(io.stderr.buf.startsWith('error: unknown command: nope\n')).toBe(
      true,
    )
    expect(io.exitCode).toBe(2)
  })

  it('cli entry via agent-cli.mjs runs help', () => {
    const spawned = execFileSync(
      process.execPath,
      [path.join(here, 'agent-cli.mjs'), 'help'],
      { encoding: 'utf8' },
    )
    expect(spawned).toContain('usage: pnpm agent')
  })

  it('parse failures before o is set still return text errors', () => {
    const r = run(['--nope'])
    expect(r.code).toBe(2)
    expect(r.err).toBe('error: unknown option --nope')
    expect(r.out).toBeUndefined()
  })

  it('quiet strips ansi while non-quiet keeps it on PR URL', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, '## Summary\n')
    const ansiUrl = '\u001b[32mhttps://example.com/pr/9\u001b[0m\n'
    const handlers = [
      ...envOk,
      ['git status --porcelain', { stdout: '' }],
      ['git branch --show-current', { stdout: 'feat/demo\n' }],
      ['git rev-list --count origin/main..HEAD', { stdout: '1\n' }],

      ['git push', { code: 0 }],
      ['gh pr list --head', { stdout: 'null\n' }],
      ['gh pr create', { stdout: ansiUrl }],
    ]
    const quiet = run(
      [
        'finish',
        '--json',
        '--quiet',
        '--root',
        root,
        '--title',
        't',
        '--body-file',
        body,
      ],
      { cwd: root, exec: fakeExec(handlers), env: {} },
    )
    expect(JSON.parse(quiet.out).prUrl).toBe('https://example.com/pr/9')

    const loud = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      { cwd: root, exec: fakeExec(handlers), env: {} },
    )
    expect(JSON.parse(loud.out).prUrl).toContain('\u001b[32m')
  })

  it('rethrows non-AgentError', () => {
    const root = tmpRoot()
    expect(() =>
      run(['preflight', '--root', root], {
        cwd: root,
        exec: () => {
          throw new TypeError('boom')
        },
        env: {},
      }),
    ).toThrow(TypeError)
  })
})

describe('claimed set and merge helpers', () => {
  it('collectSkipSlugs includes local and worktree feat/fix branches', () => {
    const exec = fakeExec([
      ['gh pr list', { stdout: '' }],
      ['git branch -r', { stdout: '' }],
      [
        'git branch --format',
        { stdout: 'main\nfeat/local-only\nfix/local-fix\n' },
      ],
      [
        'git worktree list --porcelain',
        {
          stdout:
            'worktree /tmp/a\nHEAD abc\nbranch refs/heads/feat/wt-held\n\nworktree /tmp/b\nHEAD def\nbranch refs/heads/main\n',
        },
      ],
    ])
    const skips = collectSkipSlugs(exec, '/tmp', {}, true, 'extra-slug')
    expect(skips).toEqual(
      expect.arrayContaining([
        'extra-slug',
        'local-only',
        'local-fix',
        'wt-held',
      ]),
    )
  })

  it('collectSkipSlugs fails when local branch or worktree list fails', () => {
    expect(() =>
      collectSkipSlugs(
        fakeExec([
          ['gh pr list', { stdout: '' }],
          ['git branch -r', { stdout: '' }],
          ['git branch --format', { code: 1, stderr: 'nope\n' }],
        ]),
        '/tmp',
        {},
        true,
        '',
      ),
    ).toThrow(/git branch failed/)
    expect(() =>
      collectSkipSlugs(
        fakeExec([
          ['gh pr list', { stdout: '' }],
          ['git branch -r', { stdout: '' }],
          ['git branch --format', { stdout: '' }],
          ['git worktree list --porcelain', { code: 1, stderr: 'wt fail\n' }],
        ]),
        '/tmp',
        {},
        true,
        '',
      ),
    ).toThrow(/git worktree list failed/)
  })

  it('resolvePureAddIndexConflict keeps both added index lines; modified lines refuse', () => {
    const base = 'header\nline z\n'
    const ours = 'header\n- [ ] [prep] [one](roadmap/M/one.md) — one\nline z\n'
    const theirs =
      'header\n- [ ] [prep] [two](roadmap/M/two.md) — two\nline z\n'
    const resolved = resolvePureAddIndexConflict(base, ours, theirs)
    expect(resolved).toContain('one.md')
    expect(resolved).toContain('two.md')
    expect(resolved).toMatch(/^header\n/)
    expect(resolved).toMatch(/line z\n$/)
    expect(
      resolvePureAddIndexConflict(
        '- [ ] [prep] [one](roadmap/M/one.md) — old\n',
        '- [x] [prep] [one](roadmap/M/one.md) — old\n',
        '- [ ] [prep] [one](roadmap/M/one.md) — reworded\n',
      ),
    ).toBeNull()
  })

  it('tryResolveTrivialConflicts auto-resolves pure-add index; refuses item files and modified lines', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    const base = 'header\nline z\n'
    const ours = 'header\n- [ ] [prep] [one](roadmap/M/one.md) — one\nline z\n'
    const theirs =
      'header\n- [ ] [prep] [two](roadmap/M/two.md) — two\nline z\n'
    const execOk = fakeExec([
      ['git show :1:docs/roadmap.md', { stdout: base }],
      ['git show :2:docs/roadmap.md', { stdout: ours }],
      ['git show :3:docs/roadmap.md', { stdout: theirs }],
    ])
    expect(tryResolveTrivialConflicts(root, ['docs/roadmap.md'], execOk)).toBe(
      true,
    )
    const out = fs.readFileSync(path.join(root, 'docs/roadmap.md'), 'utf8')
    expect(out).toContain('one.md')
    expect(out).toContain('two.md')

    expect(tryResolveTrivialConflicts(root, ['src/app.ts'], execOk)).toBe(false)
    expect(
      tryResolveTrivialConflicts(root, ['docs/roadmap/M2.1/item.md'], execOk),
    ).toBe(false)
    expect(
      tryResolveTrivialConflicts(root, ['docs/roadmap/RULES.md'], execOk),
    ).toBe(false)
    expect(
      tryResolveTrivialConflicts(
        root,
        ['pnpm-lock.yaml', 'package.json'],
        execOk,
      ),
    ).toBe(false)

    const execMod = fakeExec([
      [
        'git show :1:docs/roadmap.md',
        { stdout: '- [ ] [prep] [one](roadmap/M/one.md) — old\n' },
      ],
      [
        'git show :2:docs/roadmap.md',
        { stdout: '- [x] [prep] [one](roadmap/M/one.md) — old\n' },
      ],
      [
        'git show :3:docs/roadmap.md',
        { stdout: '- [ ] [prep] [one](roadmap/M/one.md) — reworded\n' },
      ],
    ])
    expect(tryResolveTrivialConflicts(root, ['docs/roadmap.md'], execMod)).toBe(
      false,
    )
  })

  it('mergeOriginMainIfNeeded skips when ancestor, merges cleanly, resolves pure-add, stops on semantic', () => {
    const root = tmpRoot(true)
    expect(
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 0 }],
        ]),
        root,
        root,
        {},
        true,
      ),
    ).toEqual({ merged: false })

    expect(
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 0 }],
        ]),
        root,
        root,
        {},
        true,
      ),
    ).toEqual({ merged: true })

    const conflictRoot = tmpRoot(true)
    fs.mkdirSync(path.join(conflictRoot, 'docs'), { recursive: true })
    const base = 'header\n'
    const ours = 'header\n- [ ] a\n'
    const theirs = 'header\n- [ ] b\n'
    expect(
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 1, stderr: 'conflict\n' }],
          [
            'git diff --name-only --diff-filter=U',
            { stdout: 'docs/roadmap.md\n' },
          ],
          ['git show :1:docs/roadmap.md', { stdout: base }],
          ['git show :2:docs/roadmap.md', { stdout: ours }],
          ['git show :3:docs/roadmap.md', { stdout: theirs }],
          ['pnpm -s roadmap check', { code: 0 }],
          ['git add --', { code: 0 }],
          ['git commit --no-edit', { code: 0 }],
        ]),
        conflictRoot,
        conflictRoot,
        {},
        true,
      ),
    ).toMatchObject({ merged: true, resolved: ['docs/roadmap.md'] })
    expect(
      fs.readFileSync(path.join(conflictRoot, 'docs/roadmap.md'), 'utf8'),
    ).toContain('- [ ] a')
    expect(
      fs.readFileSync(path.join(conflictRoot, 'docs/roadmap.md'), 'utf8'),
    ).toContain('- [ ] b')

    expect(() =>
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 1, stderr: 'conflict\n' }],
          ['git diff --name-only --diff-filter=U', { stdout: 'src/app.ts\n' }],
        ]),
        root,
        root,
        {},
        true,
      ),
    ).toThrow(/Resolve per git-finish\.mdc/)

    expect(() =>
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 1, stderr: 'conflict\n' }],
          [
            'git diff --name-only --diff-filter=U',
            { stdout: 'docs/roadmap/M2.1/item.md\n' },
          ],
        ]),
        root,
        root,
        {},
        true,
      ),
    ).toThrow(/Resolve per git-finish\.mdc/)

    const checkFailRoot = tmpRoot(true)
    fs.mkdirSync(path.join(checkFailRoot, 'docs'), { recursive: true })
    expect(() =>
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 1, stderr: 'conflict\n' }],
          [
            'git diff --name-only --diff-filter=U',
            { stdout: 'docs/roadmap.md\n' },
          ],
          ['git show :1:docs/roadmap.md', { stdout: base }],
          ['git show :2:docs/roadmap.md', { stdout: ours }],
          ['git show :3:docs/roadmap.md', { stdout: theirs }],
          ['pnpm -s roadmap check', { code: 1, stderr: 'duplicate slug\n' }],
        ]),
        checkFailRoot,
        checkFailRoot,
        {},
        true,
      ),
    ).toThrow(/roadmap check failed.*git-finish\.mdc/s)

    const lockRoot = tmpRoot(true)
    fs.writeFileSync(path.join(lockRoot, 'pnpm-lock.yaml'), 'lock: 1\n')
    expect(
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 1, stderr: 'conflict\n' }],
          [
            'git diff --name-only --diff-filter=U',
            { stdout: 'pnpm-lock.yaml\n' },
          ],
          ['pnpm install', { code: 0 }],
          ['git add --', { code: 0 }],
          ['git commit --no-edit', { code: 0 }],
        ]),
        lockRoot,
        lockRoot,
        {},
        true,
      ),
    ).toMatchObject({ merged: true, resolved: ['pnpm-lock.yaml'] })
  })

  it('switchFeatureBranch reuses current branch, existing local, refuses other worktree', () => {
    const quiet = true
    const env = {}
    const cwd = '/tmp/wt-a'

    switchFeatureBranch(
      fakeExec([
        [
          'git switch -c feat/x --no-track origin/main',
          { code: 1, stderr: 'exists\n' },
        ],
        ['git branch --show-current', { stdout: 'feat/x\n' }],
      ]),
      cwd,
      env,
      quiet,
      'feat/x',
      true,
    )

    const calls = []
    const execReuse = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      const key = `${file} ${args.join(' ')}`
      if (key.includes('git switch -c'))
        return { code: 1, stdout: '', stderr: 'exists\n' }
      if (key.includes('git branch --show-current'))
        return { code: 0, stdout: 'main\n', stderr: '' }
      if (key.includes('git show-ref --verify'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git merge-base'))
        return { code: 0, stdout: 'abc\n', stderr: '' }
      if (key.includes('git worktree list'))
        return {
          code: 0,
          stdout: `worktree ${cwd}\nHEAD a\nbranch refs/heads/main\n`,
          stderr: '',
        }
      if (key === 'git switch feat/x')
        return { code: 0, stdout: '', stderr: '' }
      return { code: 1, stdout: '', stderr: `unhandled ${key}` }
    }
    switchFeatureBranch(execReuse, cwd, env, quiet, 'feat/x', true)
    expect(calls.some((c) => c === 'git switch feat/x')).toBe(true)

    expect(() =>
      switchFeatureBranch(
        fakeExec([
          [
            'git switch -c feat/held --no-track origin/main',
            { code: 1, stderr: 'exists\n' },
          ],
          ['git branch --show-current', { stdout: 'main\n' }],
          ['git show-ref --verify', { code: 0 }],
          [
            'git merge-base feat/held origin/main',
            { code: 0, stdout: 'abc\n' },
          ],
          [
            'git worktree list --porcelain',
            {
              stdout:
                'worktree /tmp/other\nHEAD a\nbranch refs/heads/feat/held\n\nworktree /tmp/wt-a\nHEAD b\nbranch refs/heads/main\n',
            },
          ],
        ]),
        cwd,
        env,
        quiet,
        'feat/held',
        true,
      ),
    ).toThrow(/another worktree/)

    expect(() =>
      switchFeatureBranch(
        fakeExec([
          [
            'git switch -c feat/orphan --no-track origin/main',
            { code: 1, stderr: 'exists\n' },
          ],
          ['git branch --show-current', { stdout: 'main\n' }],
          ['git show-ref --verify', { code: 0 }],
          [
            'git merge-base feat/orphan origin/main',
            { code: 1, stderr: 'unrelated\n' },
          ],
        ]),
        cwd,
        env,
        quiet,
        'feat/orphan',
        true,
      ),
    ).toThrow(/does not share history with origin\/main/)

    expect(
      branchHeldInOtherWorktree(
        fakeExec([
          [
            'git worktree list --porcelain',
            {
              stdout: `worktree ${cwd}\nHEAD a\nbranch refs/heads/feat/mine\n`,
            },
          ],
        ]),
        cwd,
        env,
        quiet,
        'feat/mine',
      ),
    ).toBeNull()

    expect(() =>
      branchHeldInOtherWorktree(
        fakeExec([
          ['git worktree list --porcelain', { code: 2, stderr: 'wt down\n' }],
        ]),
        cwd,
        env,
        quiet,
        'feat/x',
      ),
    ).toThrow(/git worktree list failed/)
  })

  it('slugFromFeatFix and pure-add empty / stages-missing edges', () => {
    expect(slugFromFeatFix('feat/a')).toBe('a')
    expect(slugFromFeatFix('fix/b')).toBe('b')
    expect(slugFromFeatFix('main')).toBeNull()
    expect(slugFromFeatFix(undefined)).toBeNull()
    expect(resolvePureAddIndexConflict('', '', '')).toBe('')
    expect(
      tryResolveTrivialConflicts(
        tmpRoot(),
        ['docs/roadmap.md'],
        fakeExec([
          ['git show :1:docs/roadmap.md', { code: 1, stderr: 'no\n' }],
        ]),
      ),
    ).toBe(false)
  })

  it('mergeOriginMainIfNeeded refuses empty unmerged file list', () => {
    const root = tmpRoot(true)
    expect(() =>
      mergeOriginMainIfNeeded(
        fakeExec([
          ['git fetch origin', { code: 0 }],
          ['git merge-base --is-ancestor', { code: 1 }],
          ['git merge origin/main', { code: 1, stderr: 'conflict\n' }],
          ['git diff --name-only --diff-filter=U', { stdout: '' }],
        ]),
        root,
        root,
        {},
        true,
      ),
    ).toThrow(/files: unknown/)
  })

  it('finish does not merge origin/main before push', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    let merged = false
    const exec = (file, args) => {
      const key = `${file} ${args.join(' ')}`
      if (key.includes('node -v'))
        return { code: 0, stdout: 'v22.0.0\n', stderr: '' }
      if (key.includes('command -v pnpm'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git status --porcelain'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('git branch --show-current'))
        return { code: 0, stdout: 'feat/demo\n', stderr: '' }
      if (key.includes('git rev-list'))
        return { code: 0, stdout: '1\n', stderr: '' }
      if (key.includes('git merge origin/main')) {
        merged = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (key.includes('git rev-parse --git-path'))
        return {
          code: 0,
          stdout: '.git/agent-finish-push-failures.json\n',
          stderr: '',
        }
      if (key.includes('git push')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('gh pr list'))
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 1,
            url: 'https://example.com/pr/1',
          }),
          stderr: '',
        }
      return { code: 1, stdout: '', stderr: `unhandled ${key}` }
    }
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      { cwd: root, exec, env: {} },
    )
    expect(r.code, r.err).toBe(0)
    expect(merged).toBe(false)
    expect(JSON.parse(r.out).ok).toBe(true)
  })

  it('finish fails on non-fast-forward without merging origin/main', () => {
    const root = tmpRoot(true)
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'b\n')
    let mergeCalls = 0
    let pushCount = 0
    const wrapped = (file, args, opts) => {
      const key = `${file} ${args.join(' ')}`
      if (key.includes('git push')) {
        pushCount++
        return { code: 1, stderr: 'updates were rejected\n', stdout: '' }
      }
      if (key.includes('git merge origin/main')) {
        mergeCalls++
        return { code: 0, stdout: '', stderr: '' }
      }
      return fakeExec([
        ...envOk,
        ['git status --porcelain', { stdout: '' }],
        ['git branch --show-current', { stdout: 'feat/demo\n' }],
        ['git rev-list --count origin/main..HEAD', { stdout: '1\n' }],
      ])(file, args, opts)
    }
    const r = run(
      ['finish', '--json', '--root', root, '--title', 't', '--body-file', body],
      { cwd: root, exec: wrapped, env: {} },
    )
    expect(r.code).toBe(1)
    expect(pushCount).toBe(1)
    expect(mergeCalls).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.ok).toBe(false)
    expect(j.stage).toBe('push')
    expect(j.pushAttempts).toBe(1)
    expect(j.summary).toMatch(/Finish does not merge origin\/main/)
    expect(j.summary).toMatch(/orchestrator should refresh\/rebase/)
    expect(readPushFailures(root)).toEqual({ 'feat/demo': 1 })
  })
})

describe('linked worktree preflight --slug', () => {
  it('creates feat branch from origin/main while main is checked out elsewhere', () => {
    const primary = gitInitRepo()
    gitExec(['branch', '-M', 'main'], primary)
    fs.mkdirSync(path.join(primary, 'openspec', 'changes'), { recursive: true })
    fs.writeFileSync(
      path.join(primary, 'openspec', 'config.yaml'),
      [
        'schema: spec-driven',
        'rules:',
        '  proposal:',
        "    - 'Keep proposals under 80 words.'",
        '',
      ].join('\n'),
    )
    fs.mkdirSync(path.join(primary, 'docs/roadmap/M2.1'), { recursive: true })
    fs.writeFileSync(
      path.join(primary, 'docs/roadmap.md'),
      '# R\n\n## M2.1 — t\n\n- [ ] [prep] [wt-slug](roadmap/M2.1/wt-slug.md) — t\n',
    )
    fs.writeFileSync(
      path.join(primary, 'docs/roadmap/M2.1/wt-slug.md'),
      '# wt-slug\n\nTag: prep\nMilestone: M2.1\nTitle: t\n',
    )
    gitExec(['add', '-A'], primary)
    gitExec(
      [
        '-c',
        'user.email=t@t.com',
        '-c',
        'user.name=t',
        'commit',
        '-m',
        'wt fixture',
      ],
      primary,
    )
    gitExec(['checkout', '-b', 'origin-main-tmp'], primary)
    // Simulate origin/main as a local ref the worktree can track.
    gitExec(['branch', 'origin/main', 'main'], primary)
    gitExec(['checkout', 'main'], primary)
    const wt = path.join(os.tmpdir(), `agent-wt-${path.basename(primary)}`)
    tmpDirs.push(wt)
    gitExec(['worktree', 'add', '--detach', wt], primary)
    // Real git for worktree ops; stub only external tools + roadmap next path via thin wrapper.
    const real = defaultExec
    const exec = (file, args, opts = {}) => {
      const key = `${file} ${args.join(' ')}`
      if (key.includes('node -v'))
        return { code: 0, stdout: 'v22.0.0\n', stderr: '' }
      if (key.includes('command -v pnpm'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('gh pr list')) return { code: 0, stdout: '', stderr: '' }
      if (key.includes('pnpm') && key.includes('roadmap next')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            slug: 'wt-slug',
            tag: 'prep',
            title: 't',
            file: 'docs/roadmap/M2.1/wt-slug.md',
            milestone: 'M2.1',
            goal: ['g'],
          }),
          stderr: '',
        }
      }
      if (key.includes('openspec new'))
        return { code: 0, stdout: '', stderr: '' }
      if (key.includes('openspec status'))
        return {
          code: 0,
          stdout:
            JSON.stringify({
              artifacts: [{ id: 'proposal', status: 'ready' }],
            }) + '\n',
          stderr: '',
        }
      if (key.includes('openspec instructions'))
        return {
          code: 0,
          stdout: JSON.stringify({ template: 'T', rules: ['r'] }),
          stderr: '',
        }
      // Map origin/main for switch --no-track when remote is absent.
      if (key.includes('git switch -c feat/wt-slug --no-track origin/main')) {
        return real(
          'git',
          ['switch', '-c', 'feat/wt-slug', '--no-track', 'main'],
          { ...opts, cwd: wt },
        )
      }
      if (key.includes('git fetch')) return { code: 0, stdout: '', stderr: '' }
      return real(file, args, { ...opts, cwd: opts.cwd ?? wt })
    }
    const r = cmdPreflight(
      { slug: 'wt-slug' },
      { root: wt, cwd: wt, env: {}, exec, quiet: true },
    )
    expect(r.ok).toBe(true)
    expect(r.item.slug).toBe('wt-slug')
    expect(r.branch).toBe('feat/wt-slug')
    const br = String(gitExecIsolated(['branch', '--show-current'], wt)).trim()
    expect(br).toBe('feat/wt-slug')
    const mainBr = String(
      gitExecIsolated(['branch', '--show-current'], primary),
    ).trim()
    expect(mainBr).toBe('main')
    expect(readRunStarted(wt)?.branch).toBe('feat/wt-slug')
  })
})

describe('E2E_PORT config', () => {
  it('playwright config wires E2E_PORT and disables server reuse', () => {
    const src = fs.readFileSync(
      path.join(here, '..', '..', '..', 'playwright.config.ts'),
      'utf8',
    )
    expect(src).toMatch(/E2E_PORT \?\? ['"]4173['"]/)
    expect(src).toMatch(/reuseExistingServer:\s*false/)
    expect(src).toMatch(/--port \$\{e2ePort\}/)
  })
})
