/**
 * Thin CI failure brief from GitHub check-runs / annotations.
 * Used by `pnpm agent ci-brief` (stage 13) — not raw job log spelunking.
 */

export const ANNOTATION_CAP = 20
export const DEFAULT_POLL_MS = 12_000
export const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000

export class CiBriefError extends Error {
  constructor(msg, code = 2) {
    super(msg)
    this.exitCode = code
  }
}

const fail = (m, code = 2) => {
  throw new CiBriefError(m, code)
}

/** Sync sleep via Atomics.wait (injectable in tests). */
export function defaultSleep(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n)
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function parsePrNumber(raw) {
  if (raw == null || raw === '') fail('--pr needs a positive integer')
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n))
    fail(`--pr must be a positive integer (got ${JSON.stringify(raw)})`)
  return n
}

/**
 * Resolve PR number from `--pr` or `gh pr view --json number`.
 * @param {{ exec: Function, cwd: string, env?: NodeJS.ProcessEnv, pr?: string|number, quiet?: boolean }} opts
 */
export function resolvePrNumber(opts) {
  const { exec, cwd, env, pr, quiet } = opts
  if (pr != null && pr !== '') return parsePrNumber(pr)
  const r = exec('gh', ['pr', 'view', '--json', 'number'], { cwd, env })
  if ((r.code ?? 0) !== 0) {
    fail(
      `gh pr view failed (no PR for current branch? use --pr N):\n${String(r.stderr || r.stdout || '').trim()}`,
      r.code || 1,
    )
  }
  let j
  try {
    j = JSON.parse(String(r.stdout ?? ''))
  } catch {
    fail(`gh pr view returned invalid JSON:\n${String(r.stdout ?? '').trim()}`)
  }
  const n = Number(j?.number)
  if (!Number.isFinite(n) || n < 1)
    fail('gh pr view did not return a PR number (use --pr N)')
  if (quiet) {
    /* strip handled by caller if needed */
  }
  return n
}

/**
 * @param {string} stdout
 * @returns {Array<{ name?: string, state?: string, bucket?: string, link?: string, description?: string, workflow?: string }>}
 */
export function parseChecksJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(`gh pr checks returned invalid JSON:\n${text.slice(0, 400)}`)
  }
  if (!Array.isArray(parsed)) fail('gh pr checks JSON must be an array')
  return parsed
}

/** @param {{ bucket?: string, state?: string }} c */
export function checkBucket(c) {
  const b = String(c?.bucket ?? '').toLowerCase()
  if (b) return b
  const s = String(c?.state ?? '').toLowerCase()
  if (/fail|error|timed|cancel|action_required|startup/.test(s)) return 'fail'
  if (/pend|progress|queued|waiting|in_progress|requested/.test(s))
    return 'pending'
  if (/skip/.test(s)) return 'skipping'
  if (/success|pass|neutral|complet/.test(s)) return 'pass'
  return s || 'pending'
}

/** @param {Array<{ bucket?: string, state?: string }>} checks */
export function listFailedChecks(checks) {
  return (checks ?? []).filter((c) => checkBucket(c) === 'fail')
}

/** @param {Array<{ bucket?: string, state?: string }>} checks */
export function listPendingChecks(checks) {
  return (checks ?? []).filter((c) => checkBucket(c) === 'pending')
}

/**
 * Stop watching when any check failed, or none remain pending.
 * @param {Array<{ bucket?: string, state?: string }>} checks
 */
export function watchShouldStop(checks) {
  if (listFailedChecks(checks).length > 0) return true
  return listPendingChecks(checks).length === 0
}

/**
 * Normalize a GitHub check-run annotation.
 * @param {Record<string, unknown>} a
 */
export function normalizeAnnotation(a) {
  const path = a?.path != null ? String(a.path) : ''
  const lineRaw = a?.start_line ?? a?.line
  const line =
    lineRaw == null || lineRaw === ''
      ? null
      : Number.isFinite(Number(lineRaw))
        ? Number(lineRaw)
        : null
  const message = String(a?.message ?? '').trim()
  const level = a?.annotation_level != null ? String(a.annotation_level) : null
  return { path, line, message, level }
}

/**
 * Cap annotations across failures (stable order).
 * @param {Array<{ annotations?: unknown[] }>} failures
 * @param {number} [cap]
 */
export function capFailureAnnotations(failures, cap = ANNOTATION_CAP) {
  let left = Math.max(0, cap)
  return (failures ?? []).map((f) => {
    const all = Array.isArray(f.annotations) ? f.annotations : []
    const take = all.slice(0, left)
    left = Math.max(0, left - take.length)
    return { ...f, annotations: take }
  })
}

/**
 * Fetch PR checks JSON. `gh pr checks` exits non-zero on fail/pending — still parse stdout.
 * @param {{ exec: Function, cwd: string, env?: NodeJS.ProcessEnv, pr: number }} opts
 */
export function fetchPrChecks(opts) {
  const { exec, cwd, env, pr } = opts
  const r = exec(
    'gh',
    [
      'pr',
      'checks',
      String(pr),
      '--json',
      'name,state,bucket,link,description,workflow',
    ],
    { cwd, env },
  )
  // Exit 8 = pending, 1 = failure — JSON still on stdout when --json is used.
  const checks = parseChecksJson(r.stdout)
  if ((r.code ?? 0) !== 0 && checks.length === 0 && !String(r.stdout ?? '').trim()) {
    fail(
      `gh pr checks failed (exit ${r.code ?? 1}):\n${String(r.stderr || '').trim()}`,
      r.code || 1,
    )
  }
  return checks
}

/**
 * @param {{ exec: Function, cwd: string, env?: NodeJS.ProcessEnv, pr: number }} opts
 * @returns {{ headSha: string, nameWithOwner: string, prUrl: string|null }}
 */
export function fetchPrMeta(opts) {
  const { exec, cwd, env, pr } = opts
  const r = exec(
    'gh',
    ['pr', 'view', String(pr), '--json', 'headRefOid,url,headRepository'],
    { cwd, env },
  )
  if ((r.code ?? 0) !== 0) {
    fail(
      `gh pr view ${pr} failed:\n${String(r.stderr || r.stdout || '').trim()}`,
      r.code || 1,
    )
  }
  let j
  try {
    j = JSON.parse(String(r.stdout ?? ''))
  } catch {
    fail(`gh pr view returned invalid JSON:\n${String(r.stdout ?? '').trim()}`)
  }
  const headSha = String(j?.headRefOid ?? '').trim()
  if (!headSha) fail(`gh pr view ${pr} missing headRefOid`)

  let nameWithOwner = ''
  const nested = j?.headRepository?.nameWithOwner
  if (nested) nameWithOwner = String(nested)

  if (!nameWithOwner) {
    const repo = exec('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      cwd,
      env,
    })
    if ((repo.code ?? 0) === 0) {
      try {
        nameWithOwner = String(
          JSON.parse(String(repo.stdout ?? ''))?.nameWithOwner ?? '',
        )
      } catch {
        /* ignore */
      }
    }
  }
  if (!nameWithOwner) fail('could not resolve repository nameWithOwner')

  return {
    headSha,
    nameWithOwner,
    prUrl: j?.url != null ? String(j.url) : null,
  }
}

/**
 * List check-runs for a commit (paginated via gh api --paginate).
 * @param {{ exec: Function, cwd: string, env?: NodeJS.ProcessEnv, nameWithOwner: string, headSha: string }} opts
 */
export function fetchCheckRuns(opts) {
  const { exec, cwd, env, nameWithOwner, headSha } = opts
  const r = exec(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${nameWithOwner}/commits/${headSha}/check-runs`,
      '--jq',
      '[.check_runs[] | {id,name,conclusion,status,html_url}]',
    ],
    { cwd, env },
  )
  if ((r.code ?? 0) !== 0) {
    // Soft: brief still works without annotations.
    return []
  }
  const text = String(r.stdout ?? '').trim()
  if (!text) return []
  // --paginate may concatenate JSON arrays
  try {
    const once = JSON.parse(text)
    if (Array.isArray(once)) return once
  } catch {
    /* try NDJSON / concatenated arrays */
  }
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const chunk = JSON.parse(t)
      if (Array.isArray(chunk)) out.push(...chunk)
      else out.push(chunk)
    } catch {
      /* ignore bad chunk */
    }
  }
  return out
}

/**
 * @param {{ exec: Function, cwd: string, env?: NodeJS.ProcessEnv, nameWithOwner: string, checkRunId: number|string }} opts
 */
export function fetchCheckRunAnnotations(opts) {
  const { exec, cwd, env, nameWithOwner, checkRunId } = opts
  const r = exec(
    'gh',
    [
      'api',
      `repos/${nameWithOwner}/check-runs/${checkRunId}/annotations`,
    ],
    { cwd, env },
  )
  if ((r.code ?? 0) !== 0) return []
  const text = String(r.stdout ?? '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map(normalizeAnnotation) : []
  } catch {
    return []
  }
}

/**
 * Attach annotations to failed PR checks (matched by name).
 * @param {{ exec: Function, cwd: string, env?: NodeJS.ProcessEnv, pr: number, failed: object[] }} opts
 */
export function enrichFailuresWithAnnotations(opts) {
  const { exec, cwd, env, pr, failed } = opts
  if (!failed.length) return []

  let meta
  try {
    meta = fetchPrMeta({ exec, cwd, env, pr })
  } catch {
    return failed.map((c) => ({
      name: String(c.name ?? '(unnamed)'),
      conclusion: String(c.state ?? c.bucket ?? 'failure'),
      url: c.link != null ? String(c.link) : null,
      annotations: [],
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
    /** @type {ReturnType<typeof normalizeAnnotation>[]} */
    const annotations = []
    for (const run of matching) {
      if (run.id == null) continue
      annotations.push(
        ...fetchCheckRunAnnotations({
          exec,
          cwd,
          env,
          nameWithOwner: meta.nameWithOwner,
          checkRunId: run.id,
        }),
      )
    }
    const url =
      (c.link != null ? String(c.link) : null) ||
      (matching[0]?.html_url != null ? String(matching[0].html_url) : null)
    return {
      name,
      conclusion: String(c.state ?? c.bucket ?? 'failure'),
      url,
      annotations,
    }
  })
}

/**
 * @param {{ pr: number, checks: object[], failures: object[], timedOut?: boolean }} input
 */
export function buildBriefResult(input) {
  const { pr, checks, failures, timedOut = false } = input
  const pending = listPendingChecks(checks).length
  const failed = failures ?? []
  const capped = capFailureAnnotations(failed, ANNOTATION_CAP)
  const ok = !timedOut && failed.length === 0
  let summary
  if (timedOut) {
    summary = `timed out waiting for PR #${pr} checks (${pending} still pending)`
  } else if (failed.length > 0) {
    const ann = capped.reduce((n, f) => n + (f.annotations?.length ?? 0), 0)
    summary = `PR #${pr}: ${failed.length} failed check(s), ${ann} annotation(s)`
  } else if (pending > 0) {
    summary = `PR #${pr}: no failures yet (${pending} check(s) pending)`
  } else {
    summary = `PR #${pr}: all checks completed with no failures`
  }
  return {
    ok,
    pr,
    summary,
    failures: capped,
    pending,
    timedOut,
  }
}

/**
 * @param {{
 *   exec: Function,
 *   root?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   pr?: string|number,
 *   watch?: boolean,
 *   quiet?: boolean,
 *   sleep?: (ms: number) => void,
 *   now?: () => number,
 * }} opts
 */
export function runCiBrief(opts) {
  const exec = opts.exec
  if (typeof exec !== 'function') fail('runCiBrief requires deps.exec')
  const cwd = opts.cwd ?? opts.root ?? process.cwd()
  const env = opts.env ?? process.env
  const quiet = !!opts.quiet
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now

  const pr = resolvePrNumber({ exec, cwd, env, pr: opts.pr, quiet })
  const pollMs = Number(env.AGENT_CI_BRIEF_POLL_MS) || DEFAULT_POLL_MS
  const maxWait = Number(env.AGENT_CI_BRIEF_MAX_MS) || DEFAULT_MAX_WAIT_MS

  let checks = fetchPrChecks({ exec, cwd, env, pr })
  let timedOut = false

  if (opts.watch) {
    const start = now()
    while (!watchShouldStop(checks)) {
      if (now() - start >= maxWait) {
        timedOut = true
        break
      }
      sleep(pollMs)
      checks = fetchPrChecks({ exec, cwd, env, pr })
    }
  }

  const failedRaw = listFailedChecks(checks)
  const failures = enrichFailuresWithAnnotations({
    exec,
    cwd,
    env,
    pr,
    failed: failedRaw,
  })

  return buildBriefResult({ pr, checks, failures, timedOut })
}
