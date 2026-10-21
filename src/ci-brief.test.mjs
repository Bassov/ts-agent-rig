import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_CAP,
  CiBriefError,
  buildBriefResult,
  capFailureAnnotations,
  checkBucket,
  listFailedChecks,
  listPendingChecks,
  normalizeAnnotation,
  parseChecksJson,
  parsePrNumber,
  resolvePrNumber,
  runCiBrief,
  watchShouldStop,
} from './ci-brief.mjs'

function mockExec(handlers) {
  const calls = []
  const exec = (file, args, opts) => {
    calls.push({ file, args: [...args], opts })
    const key = `${file} ${args.join(' ')}`
    for (const h of handlers) {
      if (typeof h.match === 'function' ? h.match(file, args) : h.match.test(key)) {
        const out = typeof h.reply === 'function' ? h.reply(file, args, calls) : h.reply
        return {
          code: out.code ?? 0,
          stdout: out.stdout ?? '',
          stderr: out.stderr ?? '',
        }
      }
    }
    return { code: 1, stdout: '', stderr: `unhandled: ${key}` }
  }
  return { exec, calls }
}

describe('ci-brief helpers', () => {
  it('parsePrNumber rejects invalid values', () => {
    expect(parsePrNumber(12)).toBe(12)
    expect(parsePrNumber('7')).toBe(7)
    expect(() => parsePrNumber('x')).toThrow(CiBriefError)
    expect(() => parsePrNumber(0)).toThrow(/positive/)
  })

  it('resolvePrNumber uses --pr or gh pr view', () => {
    const { exec } = mockExec([
      {
        match: /^gh pr view --json number$/,
        reply: { stdout: JSON.stringify({ number: 42 }) },
      },
    ])
    expect(resolvePrNumber({ exec, cwd: '/r', env: {}, pr: '9' })).toBe(9)
    expect(resolvePrNumber({ exec, cwd: '/r', env: {} })).toBe(42)
  })

  it('parseChecksJson and bucket classification', () => {
    const checks = parseChecksJson(
      JSON.stringify([
        { name: 'a', bucket: 'pass', state: 'success' },
        { name: 'b', bucket: 'fail', state: 'failure' },
        { name: 'c', bucket: 'pending', state: 'pending' },
      ]),
    )
    expect(listFailedChecks(checks).map((c) => c.name)).toEqual(['b'])
    expect(listPendingChecks(checks).map((c) => c.name)).toEqual(['c'])
    expect(checkBucket({ state: 'FAILURE' })).toBe('fail')
    expect(watchShouldStop(checks)).toBe(true)
    expect(
      watchShouldStop([{ name: 'x', bucket: 'pending', state: 'pending' }]),
    ).toBe(false)
    expect(
      watchShouldStop([{ name: 'x', bucket: 'pass', state: 'success' }]),
    ).toBe(true)
  })

  it('normalizeAnnotation and capFailureAnnotations', () => {
    expect(normalizeAnnotation({ path: 'a.ts', start_line: 3, message: ' boom ' })).toEqual({
      path: 'a.ts',
      line: 3,
      message: 'boom',
      level: null,
    })
    const many = {
      name: 't',
      conclusion: 'failure',
      url: null,
      annotations: Array.from({ length: ANNOTATION_CAP + 5 }, (_, i) => ({
        path: `f${i}`,
        line: i,
        message: `m${i}`,
        level: null,
      })),
    }
    const capped = capFailureAnnotations([many, { ...many, name: 't2' }])
    expect(capped[0].annotations).toHaveLength(ANNOTATION_CAP)
    expect(capped[1].annotations).toHaveLength(0)
  })
})

describe('runCiBrief', () => {
  it('returns ok brief when all checks pass', () => {
    const { exec } = mockExec([
      {
        match: /^gh pr view --json number$/,
        reply: { stdout: JSON.stringify({ number: 10 }) },
      },
      {
        match: /gh pr checks 10 --json/,
        reply: {
          stdout: JSON.stringify([
            {
              name: 'unit',
              state: 'success',
              bucket: 'pass',
              link: 'https://example/unit',
            },
          ]),
        },
      },
    ])
    const r = runCiBrief({ exec, cwd: '/r', env: {} })
    expect(r.ok).toBe(true)
    expect(r.pr).toBe(10)
    expect(r.failures).toEqual([])
    expect(r.summary).toMatch(/no failures/)
  })

  it('builds failure brief with capped annotations (no log dump)', () => {
    const { exec, calls } = mockExec([
      {
        match: (file, args) =>
          file === 'gh' && args[0] === 'pr' && args[1] === 'checks',
        reply: {
          code: 1,
          stdout: JSON.stringify([
            {
              name: 'lint',
              state: 'failure',
              bucket: 'fail',
              link: 'https://example/lint',
            },
            {
              name: 'unit',
              state: 'success',
              bucket: 'pass',
              link: 'https://example/unit',
            },
          ]),
        },
      },
      {
        match: (file, args) =>
          file === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('--json'),
        reply: {
          stdout: JSON.stringify({
            headRefOid: 'abc',
            url: 'https://github.com/o/r/pull/3',
            headRepository: { nameWithOwner: 'o/r' },
          }),
        },
      },
      {
        match: /gh api --paginate repos\/o\/r\/commits\/abc\/check-runs/,
        reply: {
          stdout: JSON.stringify([
            {
              id: 99,
              name: 'lint',
              conclusion: 'failure',
              status: 'completed',
              html_url: 'https://example/run',
            },
          ]),
        },
      },
      {
        match: /gh api repos\/o\/r\/check-runs\/99\/annotations/,
        reply: {
          stdout: JSON.stringify([
            {
              path: 'src/a.ts',
              start_line: 12,
              annotation_level: 'failure',
              message: 'unused',
            },
            {
              path: 'src/b.ts',
              start_line: 1,
              annotation_level: 'failure',
              message: 'bad',
            },
          ]),
        },
      },
    ])

    const r = runCiBrief({ exec, cwd: '/r', env: {}, pr: 3 })
    expect(r.ok).toBe(false)
    expect(r.pr).toBe(3)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].name).toBe('lint')
    expect(r.failures[0].annotations).toEqual([
      { path: 'src/a.ts', line: 12, message: 'unused', level: 'failure' },
      { path: 'src/b.ts', line: 1, message: 'bad', level: 'failure' },
    ])
    expect(r.summary).toMatch(/1 failed/)
    // Never fetch job logs
    expect(calls.every((c) => !c.args.includes('logs') && !String(c.args).includes('job'))).toBe(
      true,
    )
  })

  it('--watch polls until failure then briefs', () => {
    let tick = 0
    const sleeps = []
    const { exec } = mockExec([
      {
        match: (file, args) =>
          file === 'gh' && args[0] === 'pr' && args[1] === 'checks',
        reply: () => {
          tick += 1
          if (tick < 3) {
            return {
              code: 8,
              stdout: JSON.stringify([
                { name: 'ci', state: 'pending', bucket: 'pending', link: '' },
              ]),
            }
          }
          return {
            code: 1,
            stdout: JSON.stringify([
              {
                name: 'ci',
                state: 'failure',
                bucket: 'fail',
                link: 'https://example/ci',
              },
            ]),
          }
        },
      },
      {
        match: (file, args) =>
          file === 'gh' && args[0] === 'pr' && args[1] === 'view',
        reply: {
          stdout: JSON.stringify({
            headRefOid: 'dead',
            url: 'https://github.com/o/r/pull/5',
            headRepository: { nameWithOwner: 'o/r' },
          }),
        },
      },
      {
        match: /gh api/,
        reply: { stdout: '[]' },
      },
    ])

    const r = runCiBrief({
      exec,
      cwd: '/r',
      env: { AGENT_CI_BRIEF_POLL_MS: '1000' },
      pr: 5,
      watch: true,
      sleep: (ms) => sleeps.push(ms),
      now: (() => {
        let t = 0
        return () => {
          t += 500
          return t
        }
      })(),
    })
    expect(r.ok).toBe(false)
    expect(r.failures[0].name).toBe('ci')
    expect(sleeps.length).toBeGreaterThanOrEqual(1)
    expect(sleeps[0]).toBe(1000)
  })

  it('--watch times out while pending', () => {
    const { exec } = mockExec([
      {
        match: /gh pr checks/,
        reply: {
          code: 8,
          stdout: JSON.stringify([
            { name: 'slow', state: 'pending', bucket: 'pending', link: '' },
          ]),
        },
      },
    ])
    let t = 0
    const r = runCiBrief({
      exec,
      cwd: '/r',
      env: {
        AGENT_CI_BRIEF_POLL_MS: '10',
        AGENT_CI_BRIEF_MAX_MS: '25',
      },
      pr: 8,
      watch: true,
      sleep: () => {},
      now: () => {
        t += 10
        return t
      },
    })
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.summary).toMatch(/timed out/)
  })

  it('buildBriefResult pending without failures is ok', () => {
    const r = buildBriefResult({
      pr: 1,
      checks: [{ name: 'x', bucket: 'pending', state: 'pending' }],
      failures: [],
    })
    expect(r.ok).toBe(true)
    expect(r.pending).toBe(1)
  })
})
