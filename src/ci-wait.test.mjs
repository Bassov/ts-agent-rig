import { describe, expect, it } from 'vitest'
import { CiBriefError } from './ci-brief.mjs'
import {
  DEFAULT_CI_WAIT_MAX_MS,
  LOG_TAIL_LINES,
  buildWaitResult,
  isIgnoredCheck,
  listRelevantFailed,
  listRelevantPending,
  parseTimeoutMs,
  relevantChecks,
  runCiWait,
  truncateLogTail,
  waitShouldStop,
} from './ci-wait.mjs'

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

describe('ci-wait helpers', () => {
  it('parseTimeoutMs defaults to 45 minutes', () => {
    expect(parseTimeoutMs(undefined)).toBe(DEFAULT_CI_WAIT_MAX_MS)
    expect(parseTimeoutMs('30')).toBe(30 * 60 * 1000)
    expect(() => parseTimeoutMs('0')).toThrow(CiBriefError)
    expect(() => parseTimeoutMs('x')).toThrow(/positive/)
  })

  it('ignores codecov/patch and skipped checks', () => {
    const checks = [
      { name: 'unit', bucket: 'pass', state: 'success' },
      { name: 'codecov/patch', bucket: 'fail', state: 'failure' },
      { name: 'optional', bucket: 'skipping', state: 'skipping' },
      { name: 'lint', bucket: 'pending', state: 'pending' },
    ]
    expect(relevantChecks(checks).map((c) => c.name)).toEqual(['unit', 'lint'])
    expect(isIgnoredCheck({ name: 'codecov/patch', bucket: 'pass' })).toBe(true)
    expect(listRelevantPending(checks).map((c) => c.name)).toEqual(['lint'])
    expect(listRelevantFailed(checks)).toEqual([])
    expect(waitShouldStop(checks)).toBe(false)
    expect(
      waitShouldStop([
        { name: 'unit', bucket: 'pass', state: 'success' },
        { name: 'codecov/patch', bucket: 'pending', state: 'pending' },
      ]),
    ).toBe(true)
  })

  it('truncateLogTail keeps last N lines', () => {
    const text = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, i) => `L${i}`).join(
      '\n',
    )
    const tail = truncateLogTail(text, LOG_TAIL_LINES)
    expect(tail.split('\n')).toHaveLength(LOG_TAIL_LINES)
    expect(tail.startsWith('L5')).toBe(true)
    expect(tail.endsWith(`L${LOG_TAIL_LINES + 4}`)).toBe(true)
  })
})

describe('runCiWait', () => {
  it('prints-path: returns ok when relevant checks pass (ignores codecov/patch fail)', () => {
    const { exec } = mockExec([
      {
        match: /^gh pr view --json number$/,
        reply: { stdout: JSON.stringify({ number: 10 }) },
      },
      {
        match: /gh pr view 10 --json/,
        reply: {
          stdout: JSON.stringify({
            headRefOid: 'abc',
            url: 'https://github.com/o/r/pull/10',
            headRepository: { nameWithOwner: 'o/r' },
          }),
        },
      },
      {
        match: /gh pr checks 10 --json/,
        reply: {
          stdout: JSON.stringify([
            { name: 'unit', state: 'success', bucket: 'pass', link: '' },
            {
              name: 'codecov/patch',
              state: 'failure',
              bucket: 'fail',
              link: '',
            },
            { name: 'docs', state: 'skipping', bucket: 'skipping', link: '' },
          ]),
        },
      },
    ])
    const r = runCiWait({ exec, cwd: '/r', env: {} })
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.pr).toBe(10)
  })

  it('fails with log tails for failed jobs', () => {
    const logLines = Array.from({ length: 100 }, (_, i) => `err line ${i}`).join(
      '\n',
    )
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
            { name: 'unit', state: 'success', bucket: 'pass', link: '' },
          ]),
        },
      },
      {
        match: (file, args) =>
          file === 'gh' &&
          args[0] === 'pr' &&
          args[1] === 'view' &&
          args.includes('--json'),
        reply: {
          stdout: JSON.stringify({
            headRefOid: 'deadbeef',
            url: 'https://github.com/o/r/pull/3',
            headRepository: { nameWithOwner: 'o/r' },
          }),
        },
      },
      {
        match: /gh api --paginate repos\/o\/r\/commits\/deadbeef\/check-runs/,
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
        match: /gh run view --job 99 --log-failed/,
        reply: { stdout: logLines },
      },
    ])

    const r = runCiWait({ exec, cwd: '/r', env: {}, pr: 3 })
    expect(r.ok).toBe(false)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].name).toBe('lint')
    expect(r.failures[0].logTail.split('\n')).toHaveLength(LOG_TAIL_LINES)
    expect(r.failures[0].logTail).toMatch(/err line 99$/)
    expect(
      calls.some(
        (c) =>
          c.file === 'gh' &&
          c.args[0] === 'run' &&
          c.args.includes('--log-failed'),
      ),
    ).toBe(true)
  })

  it('polls until settle and keeps waiting across a same-SHA re-run', () => {
    let tick = 0
    const sleeps = []
    const { exec } = mockExec([
      {
        match: (file, args) =>
          file === 'gh' && args[0] === 'pr' && args[1] === 'checks',
        reply: () => {
          tick += 1
          // pending → one pass + one pending → re-run brings first back to pending → both pass
          if (tick === 1) {
            return {
              code: 8,
              stdout: JSON.stringify([
                { name: 'a', state: 'pending', bucket: 'pending', link: '' },
                { name: 'b', state: 'pending', bucket: 'pending', link: '' },
              ]),
            }
          }
          if (tick === 2) {
            return {
              code: 8,
              stdout: JSON.stringify([
                { name: 'a', state: 'success', bucket: 'pass', link: '' },
                { name: 'b', state: 'pending', bucket: 'pending', link: '' },
              ]),
            }
          }
          if (tick === 3) {
            return {
              code: 8,
              stdout: JSON.stringify([
                { name: 'a', state: 'pending', bucket: 'pending', link: '' },
                { name: 'b', state: 'pending', bucket: 'pending', link: '' },
              ]),
            }
          }
          return {
            code: 0,
            stdout: JSON.stringify([
              { name: 'a', state: 'success', bucket: 'pass', link: '' },
              { name: 'b', state: 'success', bucket: 'pass', link: '' },
            ]),
          }
        },
      },
      {
        match: (file, args) =>
          file === 'gh' && args[0] === 'pr' && args[1] === 'view',
        reply: {
          stdout: JSON.stringify({
            headRefOid: 'same-sha',
            url: 'https://github.com/o/r/pull/5',
            headRepository: { nameWithOwner: 'o/r' },
          }),
        },
      },
    ])

    const r = runCiWait({
      exec,
      cwd: '/r',
      env: { AGENT_CI_WAIT_POLL_MS: '1000' },
      pr: 5,
      sleep: (ms) => sleeps.push(ms),
      now: (() => {
        let t = 0
        return () => {
          t += 100
          return t
        }
      })(),
    })
    expect(r.ok).toBe(true)
    expect(r.headSha).toBe('same-sha')
    expect(tick).toBe(4)
    expect(sleeps.length).toBe(3)
  })

  it('times out while relevant checks stay pending', () => {
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
      {
        match: /gh pr view/,
        reply: {
          stdout: JSON.stringify({
            headRefOid: 'x',
            url: 'https://github.com/o/r/pull/8',
            headRepository: { nameWithOwner: 'o/r' },
          }),
        },
      },
    ])
    let t = 0
    const r = runCiWait({
      exec,
      cwd: '/r',
      env: {
        AGENT_CI_WAIT_POLL_MS: '10',
        AGENT_CI_WAIT_MAX_MS: '25',
      },
      pr: 8,
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

  it('no PR for current branch surfaces via resolvePrNumber', () => {
    const { exec } = mockExec([
      {
        match: /^gh pr view --json number$/,
        reply: { code: 1, stderr: 'no pull requests found for branch' },
      },
    ])
    expect(() => runCiWait({ exec, cwd: '/r', env: {} })).toThrow(/no PR|gh pr view/)
  })

  it('buildWaitResult ok only when settled with no failures', () => {
    const r = buildWaitResult({
      pr: 1,
      checks: [{ name: 'x', bucket: 'pass', state: 'success' }],
      failures: [],
    })
    expect(r.ok).toBe(true)
    expect(r.summary).toMatch(/passed/)
  })
})
