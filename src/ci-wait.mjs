/**
 * Wait for PR checks to settle (merge-policy subset), then OK or failed log tails.
 * Used by `pnpm agent ci-wait`. Reuses ci-brief gh helpers — no duplicated fetch logic.
 */

import {
  CiBriefError,
  DEFAULT_POLL_MS,
  checkBucket,
  defaultSleep,
  fetchCheckRuns,
  fetchPrChecks,
  fetchPrMeta,
  resolvePrNumber,
} from './ci-brief.mjs'

export { CiBriefError }

/** Same as host merge policy: Codecov patch is not a merge blocker for this wait. */
export const IGNORED_CHECK_NAMES = Object.freeze(new Set(['codecov/patch']))

export const DEFAULT_CI_WAIT_MAX_MS = 45 * 60 * 1000
export const LOG_TAIL_LINES = 80

const fail = (m, code = 2) => {
  throw new CiBriefError(m, code)
}

/**
 * @param {unknown} raw
 * @param {number} [fallbackMin]
 * @returns {number} milliseconds
 */
export function parseTimeoutMs(raw, fallbackMin = 45) {
  if (raw == null || raw === '') return fallbackMin * 60 * 1000
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim())
  if (!Number.isFinite(n) || n <= 0)
    fail(`--timeout must be a positive number of minutes (got ${JSON.stringify(raw)})`)
  return n * 60 * 1000
}

/** @param {{ name?: string, bucket?: string, state?: string }} c */
export function isIgnoredCheck(c) {
  const name = String(c?.name ?? '')
  if (IGNORED_CHECK_NAMES.has(name)) return true
  const bucket = checkBucket(c)
  return bucket === 'skipping'
}

/** @param {Array<{ name?: string, bucket?: string, state?: string }>} checks */
export function relevantChecks(checks) {
  return (checks ?? []).filter((c) => !isIgnoredCheck(c))
}

/** @param {Array<{ bucket?: string, state?: string }>} checks */
export function listRelevantPending(checks) {
  return relevantChecks(checks).filter((c) => checkBucket(c) === 'pending')
}

/** @param {Array<{ bucket?: string, state?: string }>} checks */
export function listRelevantFailed(checks) {
  return relevantChecks(checks).filter((c) => checkBucket(c) === 'fail')
}

/**
 * Stop when no relevant checks remain pending (failures still wait for siblings /
 * re-runs on the same SHA to settle).
 * @param {Array<{ bucket?: string, state?: string }>} checks
 */
export function waitShouldStop(checks) {
  return listRelevantPending(checks).length === 0
}

/**
 * Last N lines of a log blob (bounded).
 * @param {string} text
 * @param {number} [n]
 */
export function truncateLogTail(text, n = LOG_TAIL_LINES) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trimEnd()
  if (!s) return ''
  const lines = s.split('\n')
  const take = Math.max(0, Number(n) || 0)
  if (lines.length <= take) return lines.join('\n')
  return lines.slice(-take).join('\n')
}

/**
 * Fetch failed-step log tail for a Actions job / check-run id.
 * @param {{
 *   exec: Function,
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   checkRunId: number|string,
 *   maxLines?: number,
 * }} opts
 */
export function fetchFailedLogTail(opts) {
  const { exec, cwd, env, checkRunId, maxLines = LOG_TAIL_LINES } = opts
  const r = exec(
    'gh',
    ['run', 'view', '--job', String(checkRunId), '--log-failed'],
    { cwd, env },
  )
  const text = String(r.stdout || r.stderr || '')
  return truncateLogTail(text, maxLines)
}

/**
 * Attach truncated failed-log tails to failed PR checks (matched by name).
 * @param {{
 *   exec: Function,
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   pr: number,
 *   failed: object[],
 *   maxLines?: number,
 * }} opts
 */
export function enrichFailuresWithLogTails(opts) {
  const { exec, cwd, env, pr, failed, maxLines = LOG_TAIL_LINES } = opts
  if (!failed.length) return []

  let meta
  try {
    meta = fetchPrMeta({ exec, cwd, env, pr })
  } catch {
    return failed.map((c) => ({
      name: String(c.name ?? '(unnamed)'),
      conclusion: String(c.state ?? c.bucket ?? 'failure'),
      url: c.link != null ? String(c.link) : null,
      logTail: '',
    }))
  }

  const runs = fetchCheckRuns({
    exec,
    cwd,
    env,
    nameWithOwner: meta.nameWithOwner,
    headSha: meta.headSha,
  })

  return failed.map((c) => {
    const name = String(c.name ?? '(unnamed)')
    const matching = runs.filter(
      (run) =>
        String(run.name ?? '') === name &&
        /fail|timed_out|cancelled|action_required|startup_failure|stale/i.test(
          String(run.conclusion ?? ''),
        ),
    )
    let logTail = ''
    for (const run of matching) {
      if (run.id == null) continue
      const tail = fetchFailedLogTail({
        exec,
        cwd,
        env,
        checkRunId: run.id,
        maxLines,
      })
      if (tail) {
        logTail = tail
        break
      }
    }
    const url =
      (c.link != null ? String(c.link) : null) ||
      (matching[0]?.html_url != null ? String(matching[0].html_url) : null)
    return {
      name,
      conclusion: String(c.state ?? c.bucket ?? 'failure'),
      url,
      logTail,
    }
  })
}

/**
 * @param {{
 *   pr: number,
 *   checks: object[],
 *   failures: object[],
 *   timedOut?: boolean,
 *   headSha?: string|null,
 * }} input
 */
export function buildWaitResult(input) {
  const { pr, checks, failures, timedOut = false, headSha = null } = input
  const pending = listRelevantPending(checks).length
  const failed = failures ?? []
  const ok = !timedOut && failed.length === 0
  let summary
  if (timedOut) {
    summary = `timed out waiting for PR #${pr} checks (${pending} still pending)`
  } else if (failed.length > 0) {
    summary = `PR #${pr}: ${failed.length} failed check(s)`
  } else {
    summary = `PR #${pr}: all checks passed`
  }
  return {
    ok,
    pr,
    summary,
    failures: failed,
    pending,
    timedOut,
    headSha,
  }
}

/**
 * @param {{
 *   exec: Function,
 *   root?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   pr?: string|number,
 *   timeout?: string|number,
 *   quiet?: boolean,
 *   sleep?: (ms: number) => void,
 *   now?: () => number,
 * }} opts
 */
export function runCiWait(opts) {
  const exec = opts.exec
  if (typeof exec !== 'function') fail('runCiWait requires deps.exec')
  const cwd = opts.cwd ?? opts.root ?? process.cwd()
  const env = opts.env ?? process.env
  const quiet = !!opts.quiet
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now

  const pr = resolvePrNumber({ exec, cwd, env, pr: opts.pr, quiet })
  const pollMs = Number(env.AGENT_CI_WAIT_POLL_MS) || DEFAULT_POLL_MS
  const maxWait =
    opts.timeout != null && opts.timeout !== ''
      ? parseTimeoutMs(opts.timeout)
      : Number(env.AGENT_CI_WAIT_MAX_MS) || DEFAULT_CI_WAIT_MAX_MS

  let headSha = null
  try {
    headSha = fetchPrMeta({ exec, cwd, env, pr }).headSha
  } catch {
    /* meta optional until failure enrichment */
  }

  let checks = fetchPrChecks({ exec, cwd, env, pr })
  let timedOut = false
  const start = now()

  while (!waitShouldStop(checks)) {
    if (now() - start >= maxWait) {
      timedOut = true
      break
    }
    sleep(pollMs)
    checks = fetchPrChecks({ exec, cwd, env, pr })
    // Re-run on the same SHA: pending reappears → loop continues until settle or timeout.
    try {
      const meta = fetchPrMeta({ exec, cwd, env, pr })
      headSha = meta.headSha
    } catch {
      /* keep prior headSha */
    }
  }

  const failedRaw = timedOut ? [] : listRelevantFailed(checks)
  const failures = timedOut
    ? []
    : enrichFailuresWithLogTails({
        exec,
        cwd,
        env,
        pr,
        failed: failedRaw,
      })

  return buildWaitResult({ pr, checks, failures, timedOut, headSha })
}
