// Agent pipeline CLI library: composite preflight / finish / review-brief.
// Entry: scripts/agent-cli.mjs (`pnpm agent`). Zero deps, Node 22, ESM.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { readReviewChecklistIds } from './review-checklist.mjs'
import {
  checkPlanSize,
  computeDiffSize,
  DIFF_SIZE_MAX,
} from './check-diff-size.mjs'
import {
  greenTreeStampPath,
  isGreenTreeStampCurrent,
  writeGreenTreeStamp,
} from './green-tree-stamp.mjs'
import {
  archiveOpenSpecChange,
  ensureOpenSpecChange,
  loadNativeArtifactInstructions,
  openSpecChangeStatus,
} from './openspec-native.mjs'

const nodeRequire = createRequire(import.meta.url)

export { readReviewChecklistIds }

export class AgentError extends Error {
  constructor(msg, code = 2) {
    super(msg)
    this.exitCode = code
  }
}
const fail = (m, code = 2) => {
  throw new AgentError(m, code)
}

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '')

/** Max bytes for outside-touch-set preview in review-brief (stat + untracked lines). */
export const OUTSIDE_TOUCH_PREVIEW_MAX = 2048

export function capOutsideTouchPreview(text) {
  const s = String(text ?? '')
  if (s.length <= OUTSIDE_TOUCH_PREVIEW_MAX) return s
  return `${s.slice(0, OUTSIDE_TOUCH_PREVIEW_MAX)}\n… (truncated, ${s.length} bytes total)`
}

/** Last N non-empty-trimmed lines of combined streams (for failure reports). */
export function tailOutput(stdout, stderr, n = 60) {
  const combined = stripAnsi(`${stdout ?? ''}\n${stderr ?? ''}`.trim())
  if (!combined) return '(no output)'
  const lines = combined.split('\n')
  return lines.slice(-n).join('\n')
}

const BOOL = new Set(['json', 'quiet', 'help', 'plan'])
const VALUE = new Set([
  'root',
  'change',
  'title',
  'body-file',
  'rules-json',
  'skip',
  'slug',
  'base',
  'out',
  'base-url',
])

/** ≤10-line apply/archive procedure embedded in the preflight run card. */
export const APPLY_ARCHIVE_PROCEDURE = `\
Apply/archive (≤10):
1. After proposal+design+tasks(+specs): review-brief --out <file>; openspec-planning-reviewer once (≤1 re-review).
2. Implement tasks; tick checkboxes; keep touch-set. No commit until first B.
3. pnpm check (OK lines only); e2e/stryker/lhci when in scope.
4. openspec-implementation-reviewer (brief --out); Manual check; Security if tagged.
5. Archive: sync delta specs, pnpm agent archive <slug>, pnpm roadmap done <slug>.
6. Stage 10: PR body. Stage 11: check:integrity + quality:self-check + agent stamp-green. Stage 12: agent finish (thin push+PR; no CI watch).
Explore: grep ≤30; offset/limit if >400 lines; no re-read; no TodoWrite in -p.
Task shape: reviewer skill set + brief file path only.`

/** Prep/contingency fast-track when Tag: prep|contingency + concrete Scope/Done when. */
export const PREP_APPLY_ARCHIVE_PROCEDURE = `\
Apply/archive prep fast-track (≤10):
1. Brief proposal.md + tasks.md; skip design.md unless arch/security; skip_specs:true if no src/ capability behavior change (touch .skip-specs / .skip-design). Skip openspec-planning-reviewer.
2. Implement; keep touch-set (intra-capability helper/test OK). No commit until first B.
3. pnpm check (OK lines); e2e/stryker/lhci when in scope.
4. openspec-implementation-reviewer; Manual check; Security if tagged.
5. Archive: sync deltas if any, pnpm agent archive <slug>, pnpm roadmap done <slug>.
6. Stage 10: PR body. Stage 11: check:integrity + quality:self-check + agent stamp-green. Stage 12: agent finish (thin push+PR; no CI watch).
Explore: grep ≤30; offset/limit if >400; no re-read; no TodoWrite in -p.
Task shape: skill set + brief path only.`

/** True when body has ## Scope, a checkbox, and - **Done when:**. */
export function hasPrepConcreteScope(body) {
  const t = String(body ?? '')
  return (
    /^## Scope\b/m.test(t) &&
    /^- \[[ xX]\] /m.test(t) &&
    /^- \*\*Done when:\*\*/m.test(t)
  )
}

export function introducesNewSrcCapability(root, body) {
  const t = String(body ?? '')
  const re = /(?:^|[\s`('"])src\/([a-z0-9-]+)\/?/g
  const seen = new Set()
  for (let m; (m = re.exec(t));) {
    const cap = m[1]
    if (!cap || seen.has(cap)) continue
    seen.add(cap)
    if (!fs.existsSync(path.join(root, 'src', cap))) return true
  }
  return false
}

export function isPrepFastTrack(item, root) {
  const tag = String(item?.tag ?? '').toLowerCase()
  if (!(tag === 'prep' || tag === 'contingency')) return false
  if (!hasPrepConcreteScope(item?.body)) return false
  if (root && introducesNewSrcCapability(root, item?.body)) return false
  return true
}

export const STATS_PEAK_CONTEXT_MAX = 300_000
export const STATS_FIRST_ROUND_INPUT_MAX = 400_000

export function parseArgs(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      o._.push(a)
      continue
    }
    let k = a.slice(2),
      v
    const eq = k.indexOf('=')
    if (eq >= 0) {
      v = k.slice(eq + 1)
      k = k.slice(0, eq)
    }
    if (BOOL.has(k)) {
      o[k] = true
      continue
    }
    if (!VALUE.has(k)) fail(`unknown option --${k}`)
    if (v === undefined) {
      v = argv[++i]
      if (v === undefined || v.startsWith('--'))
        fail(
          `--${k} needs a value (use --${k}=<value> for values starting with --)`,
        )
    }
    o[k] = v
  }
  return o
}

const HELP = `usage: pnpm agent <cmd> [--root <repo>] [--json] [--quiet]
  preflight [--slug S] [--skip a,b]   env + roadmap next (+ branch from origin/main); run card
  finish --title T --body-file F   thin push+PR (≤2/branch; no main merge; warn if stamp stale)
  stamp-green   write .cache/agent-green-tree (stage 11 after integrity+self-check)
  review-brief [--change S] [--base REF] [--rules-json '[…]'] [--out FILE]   reviewer brief
  size [--plan] [--change S]   plan estimate / merge-base..HEAD changed lines
  manual-qa [--change S] [--base-url U]   headless Playwright smoke (composer-2.5 subagent)
  instructions <artifact> [--change S]   template + rules for one artifact
  stats <path>   per-round tokens; exit 1 if peak>300K or first input>400K
  archive [--change S]   move openspec/changes/<slug> → archive/YYYY-MM-DD-<slug>
  help

Requires POSIX shell, Node matching .nvmrc, and pnpm/gh/git on PATH
(source scripts/agent-env.sh). Prefer --json for machine branching.`

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */
/** @typedef {(file: string, args: string[], opts?: object) => ExecResult} ExecFn */

/**
 * Repo-local GIT_* keys from `git rev-parse --local-env-vars` (+ INTERNAL_SUPER_PREFIX).
 * Kept out of child envs so `cwd` wins (Lefthook pre-push sets GIT_DIR / GIT_WORK_TREE).
 * Does not strip GIT_SSH* / GIT_TERMINAL_PROMPT / other non-local keys.
 */
export const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]

/** Drop ambient repo-local GIT_* overrides so `cwd` wins. */
export function execEnvForCwd(env = process.env) {
  const out = { ...env }
  for (const key of GIT_LOCAL_ENV_VARS) delete out[key]
  return out
}

export function defaultExec(file, args, opts = {}) {
  try {
    const env = execEnvForCwd(opts.env ?? process.env)
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
      env,
    })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (e) {
    const code = typeof e.status === 'number' ? e.status : 1
    const stdout = String(e.stdout ?? '')
    const stderr = String(e.stderr ?? '')
    if (!stdout && !stderr && e.message)
      return { code, stdout: '', stderr: String(e.message) }
    return { code, stdout, stderr }
  }
}

/** `git diff --no-index` exits 1 when files differ; treat 0/1 as success. */
export function mustOkDiffNoIndex(r, label) {
  if (r.code === 0 || r.code === 1) return r
  fail(
    `${label} failed (exit ${r.code}):\n${tailOutput(r.stdout, r.stderr)}`,
    r.code || 1,
  )
}

function wantQuiet(o, env) {
  return !!(o.quiet || env.CI)
}

function sh(exec, cwd, env, quiet, file, args, opts = {}) {
  const r = exec(file, args, { cwd, env, ...opts })
  if (quiet) {
    return {
      ...r,
      stdout: stripAnsi(r.stdout),
      stderr: stripAnsi(r.stderr),
    }
  }
  return r
}

export function mustOk(r, label) {
  if (r.code !== 0)
    fail(
      `${label} failed (exit ${r.code}):\n${tailOutput(r.stdout, r.stderr)}`,
      r.code || 1,
    )
  return r
}

export function readNvmrcMajor(root) {
  const p = path.join(root, '.nvmrc')
  if (!fs.existsSync(p)) return null
  const v = fs.readFileSync(p, 'utf8').trim().replace(/^v/, '')
  const maj = Number.parseInt(v.split('.')[0], 10)
  return Number.isFinite(maj) ? maj : null
}

function nodeMajor(exec, cwd, env, quiet) {
  const r = sh(exec, cwd, env, quiet, 'node', ['-v'])
  if (r.code !== 0) return null
  const m = /^v(\d+)/.exec(r.stdout.trim())
  return m ? Number(m[1]) : null
}

function assertEnv(exec, root, cwd, env, quiet) {
  const want = readNvmrcMajor(root)
  const got = nodeMajor(exec, cwd, env, quiet)
  if (want !== null && got !== want)
    fail(
      `node major is ${got ?? 'missing'}; need ${want} from .nvmrc (source scripts/agent-env.sh)`,
    )
  const pnpm = sh(exec, cwd, env, quiet, 'sh', [
    '-c',
    'command -v pnpm >/dev/null',
  ])
  if (pnpm.code !== 0)
    fail('pnpm not on PATH (source scripts/agent-env.sh once)')
  return { nodeMajor: got, nvmrcMajor: want }
}

function porcelain(exec, cwd, env, quiet) {
  return sh(exec, cwd, env, quiet, 'git', [
    'status',
    '--porcelain',
  ]).stdout.trim()
}

export function branchPrefixForItem(item) {
  if (item.tag === 'fix' || /\bbug\b/i.test(item.title ?? '')) return 'fix'
  return 'feat'
}

export function isFeatureBranch(name) {
  return /^(feat|fix)\//.test(name)
}

export function slugFromFeatFix(name) {
  const m = /^(?:feat|fix)\/(.+)$/.exec(String(name).trim())
  return m ? m[1] : null
}

export function collectSkipSlugs(exec, cwd, env, quiet, extra) {
  const fromExtra = (extra ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const pr = sh(exec, cwd, env, quiet, 'gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'headRefName',
    '-q',
    '.[].headRefName',
  ])
  if (pr.code !== 0)
    fail(
      `gh pr list failed (cannot build skip-list):\n${tailOutput(pr.stdout, pr.stderr)}`,
      pr.code || 1,
    )
  const prSlugs = pr.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((b) => b.replace(/^(feat|fix)\//, ''))
  const br = sh(exec, cwd, env, quiet, 'git', ['branch', '-r'])
  if (br.code !== 0)
    fail(
      `git branch -r failed:\n${tailOutput(br.stdout, br.stderr)}`,
      br.code || 1,
    )
  const remoteSlugs = br.stdout
    .split('\n')
    .map((l) => {
      const m = /origin\/(feat|fix)\/(\S+)/.exec(l.trim())
      return m ? m[2] : null
    })
    .filter(Boolean)
  const local = sh(exec, cwd, env, quiet, 'git', [
    'branch',
    '--format=%(refname:short)',
  ])
  if (local.code !== 0)
    fail(
      `git branch failed:\n${tailOutput(local.stdout, local.stderr)}`,
      local.code || 1,
    )
  const localSlugs = local.stdout
    .split('\n')
    .map((l) => slugFromFeatFix(l))
    .filter(Boolean)
  const wt = sh(exec, cwd, env, quiet, 'git', [
    'worktree',
    'list',
    '--porcelain',
  ])
  if (wt.code !== 0)
    fail(
      `git worktree list failed:\n${tailOutput(wt.stdout, wt.stderr)}`,
      wt.code || 1,
    )
  const worktreeSlugs = []
  for (const line of wt.stdout.split('\n')) {
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim())
    if (!m) continue
    const s = slugFromFeatFix(m[1])
    if (s) worktreeSlugs.push(s)
  }
  return [
    ...new Set([
      ...fromExtra,
      ...prSlugs,
      ...remoteSlugs,
      ...localSlugs,
      ...worktreeSlugs,
    ]),
  ]
}

export function parseRoadmapNext(text) {
  try {
    const j = JSON.parse(text)
    if (!j?.slug) fail('roadmap next JSON missing slug')
    return j
  } catch (e) {
    if (e instanceof AgentError) throw e
    const lines = text.split('\n')
    const get = (k) => {
      const line = lines.find((l) => l.startsWith(`${k}:`))
      return line ? line.slice(k.length + 1).trim() : null
    }
    const goals = lines
      .filter((l) => l.startsWith('goal:'))
      .map((l) => l.slice(5).trim())
    const slug = get('slug')
    if (!slug) fail('roadmap next produced no slug')
    const bodyIdx = lines.indexOf('---')
    return {
      slug,
      tag: get('tag'),
      title: get('title'),
      file: get('file'),
      milestone: get('milestone'),
      goal: goals,
      body: bodyIdx >= 0 ? lines.slice(bodyIdx + 1).join('\n') : undefined,
    }
  }
}

export function parseInstructions(stdout) {
  const j = JSON.parse(stdout)
  return { template: j.template ?? null, rules: j.rules ?? null }
}

/** Ready OpenSpec artifact ids from `openspec status --json`. */
export function readyArtifactIds(statusJson) {
  const arts = statusJson?.artifacts
  if (!Array.isArray(arts)) return []
  return arts.filter((a) => a && a.status === 'ready').map((a) => a.id)
}

/**
 * Load template/rules for one artifact from openspec/config.yaml (native).
 * @param {string} root
 * @param {string} artifactId
 * @param {string} [_change] unused (kept for call-site compat)
 */
export function loadArtifactInstructions(root, artifactId, _change) {
  try {
    return loadNativeArtifactInstructions(root, artifactId)
  } catch (e) {
    fail(`openspec instructions failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * @param {string} root
 * @param {string} changeSlug
 * @param {{ prepFastTrack?: boolean }} [opts]
 */
export function buildRunCard(root, changeSlug, opts = {}) {
  const prepFastTrack = Boolean(opts.prepFastTrack)
  const status = openSpecChangeStatus(root, changeSlug, { prepFastTrack })
  const ready = readyArtifactIds(status)
  /** @type {Record<string, { template: string|null, rules: unknown }>} */
  const artifacts = {}
  for (const id of ready) {
    artifacts[id] = loadArtifactInstructions(root, id, changeSlug)
  }
  return {
    ready,
    artifacts,
    procedure: prepFastTrack
      ? PREP_APPLY_ARCHIVE_PROCEDURE
      : APPLY_ARCHIVE_PROCEDURE,
    prepFastTrack,
  }
}

/** Cursor store.db estimate: chars ÷ 3.3 ≈ tokens (stated as estimate in output). */
export const STATS_CHARS_PER_TOKEN = 3.3

export function estimateTokensFromChars(chars) {
  const n = Number(chars)
  if (!Number.isFinite(n) || n < 0)
    fail('estimateTokensFromChars needs a non-negative number')
  return Math.round(n / STATS_CHARS_PER_TOKEN)
}

/** Flatten user/system string or text-part content for classification. */
export function userMessageText(msg) {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts = []
  for (const p of c) {
    if (
      p &&
      typeof p === 'object' &&
      p.type === 'text' &&
      typeof p.text === 'string'
    ) {
      parts.push(p.text)
    }
  }
  return parts.join('\n')
}

/**
 * True only for task-finished notices: optional leading `<timestamp>…</timestamp>`,
 * then the text must start with `<system_notification>`. Mentions of the tag
 * inside a normal prompt body do not count.
 */
export function isSystemNotificationUser(msg) {
  if (msg?.role !== 'user') return false
  let t = userMessageText(msg).trimStart()
  const ts = /^<timestamp>[\s\S]*?<\/timestamp>\s*/.exec(t)
  if (ts) t = t.slice(ts[0].length)
  return t.startsWith('<system_notification>')
}

export function isUserInfoPreamble(msg) {
  return (
    msg?.role === 'user' &&
    userMessageText(msg).trimStart().startsWith('<user_info>')
  )
}

export function isRoundStartingUser(msg) {
  return (
    msg?.role === 'user' &&
    !isSystemNotificationUser(msg) &&
    !isUserInfoPreamble(msg)
  )
}

function jsonValueChars(v) {
  if (v == null) return 0
  if (typeof v === 'string') return v.length
  try {
    return JSON.stringify(v).length
  } catch {
    return 0
  }
}

/**
 * Content-only char count for token estimates: text / reasoning text /
 * tool-call toolName+args / tool-result result. Excludes signatures,
 * providerOptions, ids, and other metadata.
 */
export function messageContentChars(msg) {
  if (!msg || typeof msg !== 'object') return 0
  const c = msg.content
  if (typeof c === 'string') return c.length
  if (!Array.isArray(c)) return 0
  let n = 0
  for (const p of c) {
    if (!p || typeof p !== 'object') continue
    const t = p.type
    if (t === 'text' || t === 'reasoning') {
      if (typeof p.text === 'string') n += p.text.length
    } else if (t === 'tool-call') {
      if (typeof p.toolName === 'string') n += p.toolName.length
      n += jsonValueChars(p.args ?? p.input)
    } else if (t === 'tool-result' || t === 'tool_result') {
      n += jsonValueChars(p.result)
    }
  }
  return n
}

/** Read protobuf varint; returns [value, nextOffset]. */
export function readProtobufVarint(buf, offset) {
  let x = 0
  let s = 0
  let i = offset
  while (i < buf.length) {
    const c = buf[i++]
    x |= (c & 0x7f) << s
    if ((c & 0x80) === 0) return [x, i]
    s += 7
    if (s > 70) fail('protobuf varint too long')
  }
  fail('protobuf varint truncated')
}

/**
 * Root blob field-1 length-delimited entries are 32-byte blob digests
 * (hex id = digest.toString('hex')).
 */
export function blobIdsFromRootProtobuf(rootBuf) {
  const buf = Buffer.isBuffer(rootBuf) ? rootBuf : Buffer.from(rootBuf)
  const ids = []
  let i = 0
  while (i < buf.length) {
    const [tag, i1] = readProtobufVarint(buf, i)
    i = i1
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      ;[, i] = readProtobufVarint(buf, i)
    } else if (wire === 1) {
      i += 8
    } else if (wire === 5) {
      i += 4
    } else if (wire === 2) {
      const [len, i2] = readProtobufVarint(buf, i)
      i = i2
      const slice = buf.subarray(i, i + len)
      i += len
      if (field === 1 && slice.length === 32)
        ids.push(Buffer.from(slice).toString('hex'))
    } else {
      fail(`unsupported protobuf wire type ${wire}`)
    }
  }
  return ids
}

export function roundFromCursorUsage(usage, modelCalls = 1) {
  if (!usage || typeof usage !== 'object') fail('usage object required')
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  const cacheRead = Number(usage.cacheReadTokens ?? 0)
  for (const [name, v] of [
    ['inputTokens', input],
    ['outputTokens', output],
    ['cacheReadTokens', cacheRead],
  ]) {
    if (!Number.isFinite(v) || v < 0) fail(`usage.${name} is invalid`)
  }
  const calls = Number(modelCalls)
  if (!Number.isFinite(calls) || calls < 0) fail('modelCalls is invalid')
  return {
    input,
    output,
    cacheRead,
    modelCalls: calls,
    context: input,
    estimated: false,
  }
}

function tryRoundFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (
    obj.usage &&
    typeof obj.usage === 'object' &&
    'inputTokens' in obj.usage
  ) {
    return roundFromCursorUsage(obj.usage, obj.modelCalls ?? 1)
  }
  if ('inputTokens' in obj && 'outputTokens' in obj) {
    return roundFromCursorUsage(obj, obj.modelCalls ?? 1)
  }
  return null
}

export function normalizeRounds(rows) {
  if (!Array.isArray(rows) || rows.length === 0)
    fail('stats rounds must be a non-empty array')
  return rows.map((r, i) => {
    if (!r || typeof r !== 'object') fail(`stats round ${i} is not an object`)
    const fromUsage = tryRoundFromObject(r)
    if (fromUsage) return fromUsage
    const input = Number(r.input)
    const output = Number(r.output)
    const cacheRead = Number(r.cacheRead ?? r.cache_read ?? 0)
    const modelCalls = Number(r.modelCalls ?? r.model_calls ?? 1)
    const context = Number(r.context)
    for (const [name, v] of [
      ['input', input],
      ['output', output],
      ['cacheRead', cacheRead],
      ['modelCalls', modelCalls],
      ['context', context],
    ]) {
      if (!Number.isFinite(v) || v < 0)
        fail(`stats round ${i} has invalid ${name}`)
    }
    return {
      input,
      output,
      cacheRead,
      modelCalls,
      context,
      estimated: Boolean(r.estimated),
    }
  })
}

/**
 * Split transcript messages into agent rounds.
 * Round starts: user messages that are not `<user_info>` preamble and not
 * `<system_notification>` task-finished notices. Leading system + user_info
 * are preamble. Token fields are content-chars/3.3 estimates (no signatures).
 */
export function roundsFromStoreMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    fail('store.db has no JSON role messages')
  const startIdxs = []
  for (let i = 0; i < messages.length; i++) {
    if (isRoundStartingUser(messages[i])) startIdxs.push(i)
  }
  if (startIdxs.length === 0)
    fail('store.db has no round-starting user messages after preamble')

  /** @type {object[][]} */
  const segments = []
  for (let s = 0; s < startIdxs.length; s++) {
    const from = startIdxs[s]
    const to = s + 1 < startIdxs.length ? startIdxs[s + 1] : messages.length
    segments.push(messages.slice(from, to))
  }

  let priorChars = 0
  for (let i = 0; i < startIdxs[0]; i++) {
    priorChars += messageContentChars(messages[i])
  }

  return segments.map((seg) => {
    let cum = priorChars
    let peakContext = 0
    let outputChars = 0
    let modelCalls = 0
    let sawAssistant = false
    for (const m of seg) {
      if (m?.role === 'assistant') {
        modelCalls += 1
        const ctx = estimateTokensFromChars(cum)
        if (!sawAssistant || ctx > peakContext) peakContext = ctx
        sawAssistant = true
        outputChars += messageContentChars(m)
      }
      cum += messageContentChars(m)
    }
    if (!sawAssistant) peakContext = estimateTokensFromChars(cum)
    const input = estimateTokensFromChars(
      priorChars +
        seg
          .filter((m) => m?.role === 'user' && !isSystemNotificationUser(m))
          .reduce((n, m) => n + messageContentChars(m), 0),
    )
    priorChars = cum
    return {
      input,
      output: estimateTokensFromChars(outputChars),
      cacheRead: 0,
      modelCalls,
      context: peakContext,
      estimated: true,
    }
  })
}

function parseMetaJson(value) {
  if (value == null) return null
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value)
    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      /* hex below */
    }
    const s = buf.toString('utf8')
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
      try {
        return JSON.parse(Buffer.from(s, 'hex').toString('utf8'))
      } catch {
        return null
      }
    }
    return null
  }
  const s = String(value)
  try {
    return JSON.parse(s)
  } catch {
    /* try hex-encoded JSON (Cursor store.db meta) */
  }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    try {
      const raw = Buffer.from(s, 'hex').toString('utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return null
}

export function loadRoundsFromStoreDb(db) {
  const rows = db.prepare('SELECT key, value FROM meta').all()
  if (!rows.length) fail('store.db meta is empty')
  let meta = null
  for (const row of rows) {
    const j = parseMetaJson(row.value)
    if (j?.agentStats?.rounds) return normalizeRounds(j.agentStats.rounds)
    if (j?.rounds) return normalizeRounds(j.rounds)
    if (j?.latestRootBlobId) meta = j
  }
  if (!meta?.latestRootBlobId)
    fail('store.db meta has no latestRootBlobId (and no agentStats.rounds)')
  const rootRow = db
    .prepare('SELECT data FROM blobs WHERE id = ?')
    .get(meta.latestRootBlobId)
  if (!rootRow?.data) fail('store.db missing root blob for latestRootBlobId')
  const ids = blobIdsFromRootProtobuf(rootRow.data)
  if (!ids.length) fail('store.db root blob has no field-1 blob ids')
  const messages = []
  for (const id of ids) {
    const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(id)
    if (!row?.data) fail(`store.db missing blob ${id}`)
    const raw = row.data
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (buf.length === 0 || (buf[0] !== 0x7b && buf[0] !== 0x5b)) continue
    try {
      const msg = JSON.parse(buf.toString('utf8'))
      if (msg && typeof msg === 'object' && typeof msg.role === 'string') {
        messages.push(msg)
      }
    } catch {
      fail(`store.db blob ${id} is not valid JSON`)
    }
  }
  return roundsFromStoreMessages(messages)
}

export function parseStatsRoundsJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) fail('stats document is empty')
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // Multi-line JSONL before whole-file JSON.parse.
  if (lines.length > 1 && lines.every((l) => l.startsWith('{'))) {
    const rounds = []
    for (const t of lines) {
      let row
      try {
        row = JSON.parse(t)
      } catch {
        fail('stats JSONL line is invalid JSON')
      }
      const fromUsage = tryRoundFromObject(row)
      rounds.push(fromUsage ?? row)
    }
    return normalizeRounds(rounds)
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let j
    try {
      j = JSON.parse(trimmed)
    } catch {
      fail('stats JSON is invalid')
    }
    const one = tryRoundFromObject(j)
    if (one) return [one]
    if (Array.isArray(j)) {
      if (j.length && j.every((x) => tryRoundFromObject(x))) {
        return j.map((x) => tryRoundFromObject(x))
      }
      return normalizeRounds(j)
    }
    if (j && Array.isArray(j.rounds)) return normalizeRounds(j.rounds)
    if (j?.agentStats?.rounds) return normalizeRounds(j.agentStats.rounds)
    fail(
      'stats JSON must be cursor-agent result (usage.*Tokens), {rounds:[…]}, or an array of rounds',
    )
  }
  // Multi-line `{...}` JSONL is handled above. Anything else that does not
  // start with `{`/`[` is not a supported stats document (avoid treating a
  // prompt that merely mentions tags as a format).
  for (const t of lines) {
    try {
      JSON.parse(t)
    } catch {
      fail('stats JSONL line is invalid JSON')
    }
  }
  fail(
    'stats document must be JSON ({rounds}/usage) or multi-line `{`-prefixed JSONL',
  )
}

export function loadStatsRounds(filePath) {
  if (!fs.existsSync(filePath)) fail(`stats path not found: ${filePath}`)
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.db') || lower.endsWith('.sqlite')) {
    let DatabaseSync
    try {
      ;({ DatabaseSync } = nodeRequire('node:sqlite'))
    } catch (e) {
      fail(`node:sqlite unavailable: ${e.message}`)
    }
    const db = new DatabaseSync(filePath, { readOnly: true })
    try {
      return loadRoundsFromStoreDb(db)
    } finally {
      db.close()
    }
  }
  return parseStatsRoundsJson(fs.readFileSync(filePath, 'utf8'))
}

export function summarizeStats(rounds) {
  const peakContext = Math.max(...rounds.map((r) => r.context))
  const firstInput = rounds[0].input
  const modelCalls = rounds.reduce((n, r) => n + r.modelCalls, 0)
  const estimated = rounds.some((r) => r.estimated)
  return { rounds, peakContext, firstInput, modelCalls, estimated }
}

export function statsExitCode(summary) {
  if (
    summary.peakContext > STATS_PEAK_CONTEXT_MAX ||
    summary.firstInput > STATS_FIRST_ROUND_INPUT_MAX
  ) {
    return 1
  }
  return 0
}

export function parseTouchSetPaths(designText) {
  const paths = []
  for (const line of designText.split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line)
    if (m && !m[1].includes('…') && m[1] !== 'File') paths.push(m[1])
  }
  return paths
}

export function slugFromBranch(name) {
  const m = /^(?:feat|fix)\/(.+)$/.exec(name)
  return m ? m[1] : name
}

const PUSH_FAIL_FILE = 'agent-finish-push-failures.json'
const RUN_STARTED_FILE = 'agent-run-started.json'
const PR_BODY_METRICS_FILE = 'agent-pr-body-with-metrics.md'

/** Resolve a path inside the git dir (works when `.git` is a file / linked worktree). */
export function gitPath(root, relPath, exec = defaultExec) {
  const r = exec('git', ['rev-parse', '--git-path', relPath], {
    cwd: root,
    env: process.env,
  })
  if (r.code === 0) {
    const out = r.stdout.trim()
    return path.isAbsolute(out) ? out : path.resolve(root, out)
  }
  const fallbackDir = path.join(root, '.git')
  if (fs.existsSync(fallbackDir) && fs.statSync(fallbackDir).isDirectory())
    return path.join(fallbackDir, relPath)
  fail(
    `git rev-parse --git-path ${relPath} failed under ${root}:\n${tailOutput(r.stdout, r.stderr)}`,
  )
}

export function pushFailPath(root, exec = defaultExec) {
  return gitPath(root, PUSH_FAIL_FILE, exec)
}

export function readPushFailures(root, exec = defaultExec) {
  const p = pushFailPath(root, exec)
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

export function writePushFailures(root, map, exec = defaultExec) {
  const p = pushFailPath(root, exec)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(map, null, 0) + '\n')
}

export function resolveGitRelPath(root, relPath, exec = defaultExec) {
  try {
    return gitPath(root, relPath, exec)
  } catch {
    return path.join(root, '.git', relPath)
  }
}

/**
 * @returns {{ startedAtMs: number, branch: string } | null}
 */
export function readRunStarted(root, exec = defaultExec) {
  const p = resolveGitRelPath(root, RUN_STARTED_FILE, exec)
  if (!fs.existsSync(p)) return null
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof j.startedAtMs !== 'number' || !Number.isFinite(j.startedAtMs))
      return null
    const branch = typeof j.branch === 'string' ? j.branch : ''
    return { startedAtMs: j.startedAtMs, branch }
  } catch {
    return null
  }
}

export function readRunStartedMs(root, exec = defaultExec) {
  return readRunStarted(root, exec)?.startedAtMs ?? null
}

export function writeRunStarted(
  root,
  startedAtMs = Date.now(),
  exec = defaultExec,
  branch = '',
) {
  const p = resolveGitRelPath(root, RUN_STARTED_FILE, exec)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(
    p,
    JSON.stringify({ startedAtMs, branch: String(branch ?? '') }) + '\n',
  )
  return p
}

/**
 * Write the run-start marker only when missing or for a different branch.
 * @returns {{ startedAtMs: number, branch: string, path: string, wrote: boolean }}
 */
export function ensureRunStarted(
  root,
  branch,
  startedAtMs = Date.now(),
  exec = defaultExec,
) {
  const existing = readRunStarted(root, exec)
  if (existing && existing.branch === branch) {
    return {
      startedAtMs: existing.startedAtMs,
      branch: existing.branch,
      path: resolveGitRelPath(root, RUN_STARTED_FILE, exec),
      wrote: false,
    }
  }
  const pathWritten = writeRunStarted(root, startedAtMs, exec, branch)
  return { startedAtMs, branch, path: pathWritten, wrote: true }
}

export function clearRunStarted(root, exec = defaultExec) {
  const p = resolveGitRelPath(root, RUN_STARTED_FILE, exec)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  return p
}

/**
 * Prefer launcher `AGENT_RUN_STARTED_AT` (epoch seconds); else the on-disk marker.
 */
export function resolveRunStartedMs(
  root,
  env = process.env,
  exec = defaultExec,
) {
  const raw = env.AGENT_RUN_STARTED_AT
  if (raw != null && String(raw).trim() !== '') {
    const sec = Number(String(raw).trim())
    if (Number.isFinite(sec)) return Math.round(sec * 1000)
  }
  return readRunStartedMs(root, exec)
}

/**
 * Build a PR body with an auto-filled ## Metrics section.
 * @returns {{ bodyPath: string, wallTimeSec: number | null, tokens: string | null }}
 */
export function buildPrBodyWithMetrics(
  bodyPath,
  root,
  env = process.env,
  exec = defaultExec,
  nowMs = Date.now(),
) {
  const raw = fs.readFileSync(bodyPath, 'utf8')
  const startedAtMs = resolveRunStartedMs(root, env, exec)
  const wallTimeSec =
    startedAtMs == null
      ? null
      : Math.max(0, Math.round((nowMs - startedAtMs) / 1000))
  const tokensRaw = env.AGENT_TOKEN_USAGE
  const tokens =
    tokensRaw != null && String(tokensRaw).trim() !== ''
      ? String(tokensRaw).trim()
      : null
  const metricLines = ['## Metrics', '']
  metricLines.push(
    wallTimeSec == null
      ? '- wall_time_sec: unknown'
      : `- wall_time_sec: ${wallTimeSec}`,
  )
  if (tokens != null) metricLines.push(`- tokens: ${tokens}`)
  metricLines.push('')
  const block = `${metricLines.join('\n')}\n`
  let body
  if (/^## Metrics\b/m.test(raw)) {
    body = raw.replace(/^## Metrics\b[\s\S]*?(?=^## )/m, block)
    if (body === raw) {
      body = raw.replace(/^## Metrics\b[\s\S]*$/m, `${block.trimEnd()}\n`)
    }
  } else {
    body = `${raw.trimEnd()}\n\n${block}`
  }
  const out = resolveGitRelPath(root, PR_BODY_METRICS_FILE, exec)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, body)
  return { bodyPath: out, wallTimeSec, tokens }
}

/** Path of another worktree that has `branch` checked out, or null. */
export function branchHeldInOtherWorktree(exec, cwd, env, quiet, branch) {
  const wt = sh(exec, cwd, env, quiet, 'git', [
    'worktree',
    'list',
    '--porcelain',
  ])
  if (wt.code !== 0)
    fail(
      `git worktree list failed:\n${tailOutput(wt.stdout, wt.stderr)}`,
      wt.code || 1,
    )
  const cwdAbs = path.resolve(cwd)
  let blockPath = null
  let held = null
  for (const line of wt.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      blockPath = line.slice('worktree '.length).trim()
      continue
    }
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim())
    if (m && m[1] === branch && blockPath) {
      if (path.resolve(blockPath) !== cwdAbs) held = blockPath
    }
  }
  return held
}

/**
 * Reuse an existing local branch only when it shares history with origin/main
 * and is not checked out elsewhere. Never reset or delete.
 */
function reuseExistingFeatureBranch(exec, cwd, env, quiet, branch, createFail) {
  const cur = sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current'])
  if (cur.code === 0 && cur.stdout.trim() === branch) return

  const exists = sh(exec, cwd, env, quiet, 'git', [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ])
  if (exists.code !== 0) {
    fail(
      `cannot create branch ${branch} and it does not exist locally:\n${tailOutput(createFail.stdout, createFail.stderr)}`,
      createFail.code || 1,
    )
  }

  const mb = sh(exec, cwd, env, quiet, 'git', [
    'merge-base',
    branch,
    'origin/main',
  ])
  if (mb.code !== 0) {
    fail(
      `local branch ${branch} does not share history with origin/main; refusing to switch (never reset/delete):\n${tailOutput(mb.stdout, mb.stderr)}\n${tailOutput(createFail.stdout, createFail.stderr)}`,
      mb.code || 1,
    )
  }

  const held = branchHeldInOtherWorktree(exec, cwd, env, quiet, branch)
  if (held) {
    fail(
      `branch ${branch} is checked out in another worktree (${held}); refusing to switch`,
      1,
    )
  }

  mustOk(
    sh(exec, cwd, env, quiet, 'git', ['switch', branch]),
    `git switch ${branch}`,
  )
}

export function switchFeatureBranch(
  exec,
  cwd,
  env,
  quiet,
  branch,
  fromOriginMain,
) {
  if (fromOriginMain) {
    const create = sh(exec, cwd, env, quiet, 'git', [
      'switch',
      '-c',
      branch,
      '--no-track',
      'origin/main',
    ])
    if (create.code === 0) return
    reuseExistingFeatureBranch(exec, cwd, env, quiet, branch, create)
    return
  }
  const sw = sh(exec, cwd, env, quiet, 'git', ['switch', '-c', branch])
  if (sw.code === 0) return
  reuseExistingFeatureBranch(exec, cwd, env, quiet, branch, sw)
}

/** Compact pre-push / pnpm check failure lines from push output. */
export function summarizePushFailure(stdout, stderr) {
  const combined = stripAnsi(`${stdout ?? ''}\n${stderr ?? ''}`)
  const lines = combined
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  const checkish = lines.filter(
    (l) =>
      /^OK [a-z0-9-]+ /.test(l) ||
      /^[a-z][a-z0-9-]*: /.test(l) ||
      l.startsWith('\u2026') ||
      l.startsWith('full log:'),
  )
  if (checkish.length) return checkish.slice(0, 60).join('\n')
  return tailOutput(stdout, stderr)
}

/**
 * When the current branch is behind origin/main, warn and merge-or-recreate
 * (never rebase/force). Recreate = ff-only onto origin/main when there are no
 * unique commits; otherwise merge with the finish allowlist.
 * @returns {{ stale: boolean, warning: string | null, merged: boolean, action: string | null }}
 */
export function refreshStaleFeatureBranch(exec, root, cwd, env, quiet) {
  const behindR = mustOk(
    sh(exec, cwd, env, quiet, 'git', [
      'rev-list',
      '--count',
      'HEAD..origin/main',
    ]),
    'git rev-list behind',
  )
  const behindRaw = behindR.stdout.trim()
  const behind = Number.parseInt(behindRaw, 10)
  if (!Number.isFinite(behind)) {
    fail(
      `git rev-list behind produced non-numeric count: ${behindRaw || '(empty)'}`,
      1,
    )
  }
  if (behind < 1) {
    return { stale: false, warning: null, merged: false, action: null }
  }
  const aheadR = mustOk(
    sh(exec, cwd, env, quiet, 'git', [
      'rev-list',
      '--count',
      'origin/main..HEAD',
    ]),
    'git rev-list ahead',
  )
  const ahead = Number.parseInt(aheadR.stdout.trim(), 10)
  if (!Number.isFinite(ahead)) {
    fail(
      `git rev-list ahead produced non-numeric count: ${aheadR.stdout.trim() || '(empty)'}`,
      1,
    )
  }
  if (ahead === 0) {
    const warning = `branch tip is behind origin/main by ${behind} commit(s) with no unique commits; recreating via ff-only merge (no rebase/force)`
    mustOk(
      sh(exec, cwd, env, quiet, 'git', ['merge', '--ff-only', 'origin/main']),
      'git merge --ff-only origin/main (stale recreate)',
    )
    return { stale: true, warning, merged: true, action: 'recreate-ff' }
  }
  const warning = `branch tip is behind origin/main by ${behind} commit(s); merging origin/main (no rebase/force)`
  const result = mergeOriginMainIfNeeded(exec, root, cwd, env, quiet)
  return {
    stale: true,
    warning,
    merged: Boolean(result?.merged),
    action: 'merge',
  }
}

export function cmdPreflight(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  const envInfo = assertEnv(exec, root, cwd, env, quiet)
  const dirty = porcelain(exec, cwd, env, quiet)
  if (dirty) fail(`working tree not clean:\n${dirty}`)

  mustOk(sh(exec, cwd, env, quiet, 'git', ['fetch', 'origin']), 'git fetch')
  const slugMode = Boolean(o.slug)
  if (!slugMode) {
    mustOk(
      sh(exec, cwd, env, quiet, 'git', ['switch', 'main']),
      'git switch main',
    )
    mustOk(
      sh(exec, cwd, env, quiet, 'git', ['pull', '--ff-only']),
      'git pull --ff-only',
    )
  }

  const skips = collectSkipSlugs(exec, cwd, env, quiet, o.skip)
  const nextArgs = ['-s', 'roadmap', 'next', '--json']
  if (slugMode) nextArgs.push('--slug', o.slug)
  else if (skips.length) nextArgs.push('--skip', skips.join(','))
  const nextR = mustOk(
    sh(exec, cwd, env, quiet, 'pnpm', nextArgs),
    'roadmap next',
  )
  const item = parseRoadmapNext(nextR.stdout)
  const branch = `${branchPrefixForItem(item)}/${item.slug}`
  switchFeatureBranch(exec, cwd, env, quiet, branch, slugMode)
  const stale = refreshStaleFeatureBranch(exec, root, cwd, env, quiet)
  const checklistIds = readReviewChecklistIds(root)

  ensureOpenSpecChange(root, item.slug)

  const prepFastTrack = isPrepFastTrack(item, root)
  const runCard = buildRunCard(root, item.slug, {
    prepFastTrack,
  })
  const primaryId =
    runCard.ready.find((id) => id === 'proposal') ?? runCard.ready[0] ?? null
  const instructions = primaryId
    ? runCard.artifacts[primaryId]
    : loadArtifactInstructions(root, 'proposal', item.slug)
  if (!Array.isArray(instructions.rules))
    fail('openspec instructions missing rules array')

  const designPath = path.join('openspec', 'changes', item.slug, 'design.md')
  const touchSet = fs.existsSync(path.join(root, designPath))
    ? designPath
    : prepFastTrack
      ? 'prep fast-track (design.md optional)'
      : 'TBD until design.md'

  ensureRunStarted(root, branch, Date.now(), exec)

  return {
    ok: true,
    env: envInfo,
    skips,
    branch,
    stale: stale.stale,
    staleWarning: stale.warning,
    checklistIds,
    prepFastTrack,
    item: {
      slug: item.slug,
      tag: item.tag,
      title: item.title,
      file: item.file,
      milestone: item.milestone,
      goal: item.goal || item.goals,
      body: item.body,
    },
    instructions,
    runCard,
    touchSet,
  }
}

export function assertFinishBranch(exec, cwd, env, quiet) {
  const branchR = mustOk(
    sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current']),
    'git branch',
  )
  const branch = branchR.stdout.trim()
  if (!isFeatureBranch(branch))
    fail(
      `finish refuses branch "${branch}" (need feat/* or fix/* with commits ahead of origin/main)`,
      1,
    )
  const aheadR = mustOk(
    sh(exec, cwd, env, quiet, 'git', [
      'rev-list',
      '--count',
      'origin/main..HEAD',
    ]),
    'git rev-list',
  )
  const ahead = Number.parseInt(aheadR.stdout.trim(), 10)
  if (!Number.isFinite(ahead) || ahead < 1)
    fail(
      `finish refuses: no commits ahead of origin/main (ahead=${aheadR.stdout.trim() || '0'})`,
      1,
    )
  return { branch, ahead }
}

const TRIVIAL_MERGE_FILES = new Set(['docs/roadmap.md', 'pnpm-lock.yaml'])

function splitFileLines(text) {
  const lines = String(text).split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinFileLines(lines) {
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/** Insert segments between successive base lines; null if a base line was dropped. */
function insertSegments(side, base) {
  const segs = []
  let si = 0
  for (let bi = 0; bi < base.length; bi++) {
    const insert = []
    while (si < side.length && side[si] !== base[bi]) insert.push(side[si++])
    if (si >= side.length || side[si] !== base[bi]) return null
    segs.push(insert)
    si++
  }
  segs.push(side.slice(si))
  return segs
}

function unionInserts(oursIns, theirsIns) {
  const seen = new Set(oursIns)
  return [...oursIns, ...theirsIns.filter((l) => !seen.has(l))]
}

/**
 * Auto-resolve docs/roadmap.md only when both sides purely ADD distinct whole
 * lines relative to the merge base (parallel `roadmap add`).
 * @returns {string|null}
 */
export function resolvePureAddIndexConflict(baseText, oursText, theirsText) {
  const base = splitFileLines(baseText)
  const ours = splitFileLines(oursText)
  const theirs = splitFileLines(theirsText)
  const oSeg = insertSegments(ours, base)
  const tSeg = insertSegments(theirs, base)
  if (!oSeg || !tSeg) return null
  const out = []
  for (let i = 0; i < base.length; i++) {
    out.push(...unionInserts(oSeg[i], tSeg[i]))
    out.push(base[i])
  }
  out.push(...unionInserts(oSeg[base.length], tSeg[base.length]))
  return joinFileLines(out)
}

function readGitStages(root, rel, exec) {
  const stages = []
  for (const stage of [1, 2, 3]) {
    const r = exec('git', ['show', `:${stage}:${rel}`], {
      cwd: root,
      env: process.env,
    })
    if (r.code !== 0) return null
    stages.push(r.stdout)
  }
  return { base: stages[0], ours: stages[1], theirs: stages[2] }
}

/**
 * Auto-resolve only pure-add `docs/roadmap.md` conflicts and `pnpm-lock.yaml`
 * (via install later). Refuses item files, lessons, RULES, modified-line hunks,
 * and any package.json conflict. Leaves the merge in progress on failure.
 */
export function tryResolveTrivialConflicts(
  root,
  conflicted,
  exec = defaultExec,
) {
  const files = [...new Set(conflicted)]
  if (files.includes('package.json')) return false
  if (!files.every((f) => TRIVIAL_MERGE_FILES.has(f))) return false

  if (files.includes('docs/roadmap.md')) {
    const stages = readGitStages(root, 'docs/roadmap.md', exec)
    if (!stages) return false
    const resolved = resolvePureAddIndexConflict(
      stages.base,
      stages.ours,
      stages.theirs,
    )
    if (resolved === null) return false
    fs.writeFileSync(path.join(root, 'docs/roadmap.md'), resolved)
  }
  return true
}

function refuseMergeConflict(files) {
  fail(
    `cannot auto-resolve conflict with origin/main (files: ${files.join(', ') || 'unknown'}). Resolve per git-finish.mdc, then run finish again.`,
    1,
  )
}

export function mergeOriginMainIfNeeded(exec, root, cwd, env, quiet) {
  mustOk(sh(exec, cwd, env, quiet, 'git', ['fetch', 'origin']), 'git fetch')
  const anc = sh(exec, cwd, env, quiet, 'git', [
    'merge-base',
    '--is-ancestor',
    'origin/main',
    'HEAD',
  ])
  if (anc.code === 0) return { merged: false }
  const merge = sh(exec, cwd, env, quiet, 'git', ['merge', 'origin/main'])
  if (merge.code === 0) return { merged: true }
  const unmerged = sh(exec, cwd, env, quiet, 'git', [
    'diff',
    '--name-only',
    '--diff-filter=U',
  ])
  const files = unmerged.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!files.length || !tryResolveTrivialConflicts(root, files, exec))
    refuseMergeConflict(files)
  if (files.includes('pnpm-lock.yaml')) {
    mustOk(sh(exec, cwd, env, quiet, 'pnpm', ['install']), 'pnpm install')
  }
  if (files.includes('docs/roadmap.md')) {
    const check = sh(exec, cwd, env, quiet, 'pnpm', ['-s', 'roadmap', 'check'])
    if (check.code !== 0) {
      fail(
        `roadmap check failed after auto-resolving docs/roadmap.md (semantic conflict). Resolve per git-finish.mdc, then run finish again.\n${tailOutput(check.stdout, check.stderr)}`,
        1,
      )
    }
  }
  for (const f of files) {
    mustOk(sh(exec, cwd, env, quiet, 'git', ['add', '--', f]), `git add ${f}`)
  }
  mustOk(
    sh(exec, cwd, env, quiet, 'git', [
      'commit',
      '--no-edit',
      '-m',
      'merge origin/main (trivial conflicts)',
    ]),
    'git commit merge',
  )
  return { merged: true, resolved: files }
}

export function cmdStampGreen(_o, deps) {
  const { root, cwd, env, exec } = deps
  const stamp = writeGreenTreeStamp(root, { exec, cwd, env })
  return {
    ok: true,
    stamp,
    path: greenTreeStampPath(root),
    summary: `green-tree stamp written: ${stamp}`,
  }
}

export function cmdFinish(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  assertEnv(exec, root, cwd, env, quiet)
  const dirty = porcelain(exec, cwd, env, quiet)
  if (dirty) fail(`working tree not clean (commit first):\n${dirty}`, 1)

  const { branch, ahead } = assertFinishBranch(exec, cwd, env, quiet)

  const fails = readPushFailures(root, exec)
  const prior = Number(fails[branch] ?? 0)
  if (prior >= 2) {
    return {
      ok: false,
      stage: 'push',
      pushAttempts: prior,
      branch,
      ahead,
      summary: `push budget exhausted for ${branch} (${prior} failed attempts recorded under .git/${PUSH_FAIL_FILE})`,
    }
  }

  // Thin finish: push + PR only. Stage-11 stamp gates skip-A messaging; never
  // re-run quality:self-check / integrity from finish. No happy-path main merge.
  const stampCurrent = (
    deps.isGreenTreeStampCurrent ??
    ((r) => isGreenTreeStampCurrent(r, { exec, cwd, env }))
  )(root)
  const stampNote = stampCurrent
    ? 'green-tree stamp current (A/C1/C2 ritual already stamped); '
    : 'warning: stage-11 green-tree stamp missing or stale (finish is thin; checks not re-run); '

  const lastPush = sh(exec, cwd, env, quiet, 'git', [
    'push',
    '-q',
    '-u',
    'origin',
    'HEAD',
  ])
  const pushMsg = `${lastPush.stdout}\n${lastPush.stderr}`
  if (
    lastPush.code !== 0 &&
    /non-fast-forward|fetch first|\[rejected\]|updates were rejected/i.test(
      pushMsg,
    )
  ) {
    const next = prior + 1
    writePushFailures(root, { ...fails, [branch]: next }, exec)
    return {
      ok: false,
      stage: 'push',
      pushAttempts: next,
      branch,
      ahead,
      stampCurrent,
      summary: `${stampNote}push rejected (non-fast-forward). Finish does not merge origin/main; orchestrator should refresh/rebase, then re-run finish.\n${summarizePushFailure(lastPush.stdout, lastPush.stderr)}`,
    }
  }
  if (lastPush.code !== 0) {
    const next = prior + 1
    writePushFailures(root, { ...fails, [branch]: next }, exec)
    return {
      ok: false,
      stage: 'push',
      pushAttempts: next,
      branch,
      ahead,
      stampCurrent,
      summary: `${stampNote}${summarizePushFailure(lastPush.stdout, lastPush.stderr)}`,
    }
  }
  if (fails[branch] !== undefined) {
    const rest = { ...fails }
    delete rest[branch]
    writePushFailures(root, rest, exec)
  }

  const existing = sh(exec, cwd, env, quiet, 'gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--json',
    'number,url',
    '-q',
    '.[0]',
  ])
  let prUrl = null
  let prNumber = null
  let created = false
  if (
    existing.code === 0 &&
    existing.stdout.trim() &&
    existing.stdout.trim() !== 'null'
  ) {
    try {
      const j = JSON.parse(existing.stdout)
      prNumber = j.number ?? null
      prUrl = j.url ?? null
    } catch {
      /* ignore */
    }
  }

  let metrics = null
  if (!prNumber) {
    if (!o.title) fail('finish create needs --title')
    if (!o['body-file']) fail('finish create needs --body-file')
    const bodyPath = path.resolve(cwd, o['body-file'])
    if (!fs.existsSync(bodyPath)) fail(`body file missing: ${bodyPath}`)
    metrics = buildPrBodyWithMetrics(bodyPath, root, env, exec)
    const createdPr = mustOk(
      sh(exec, cwd, env, quiet, 'gh', [
        'pr',
        'create',
        '--title',
        o.title,
        '--body-file',
        metrics.bodyPath,
      ]),
      'gh pr create',
    )
    prUrl = createdPr.stdout.trim()
    created = true
    clearRunStarted(root, exec)
  }

  return {
    ok: true,
    stage: 'pr',
    pushAttempts: prior,
    branch,
    ahead,
    prUrl,
    created,
    stampCurrent,
    metrics: metrics
      ? { wallTimeSec: metrics.wallTimeSec, tokens: metrics.tokens }
      : null,
    summary: created
      ? `${stampNote}PR created: ${prUrl}`
      : `${stampNote}PR updated (existing): ${prUrl}`,
  }
}

export function cmdReviewBrief(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  let slug = o.change
  if (!slug) {
    const br = mustOk(
      sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current']),
      'git branch',
    )
    slug = slugFromBranch(br.stdout.trim())
  }
  const changePath = path.join('openspec', 'changes', slug)
  let rules = []
  if (o['rules-json']) {
    try {
      rules = JSON.parse(o['rules-json'])
    } catch {
      fail('--rules-json must be valid JSON')
    }
  }
  const designAbs = path.join(root, changePath, 'design.md')
  let touchPaths = []
  let touchNote = null
  if (fs.existsSync(designAbs)) {
    touchPaths = parseTouchSetPaths(fs.readFileSync(designAbs, 'utf8'))
  } else {
    touchNote = 'design.md missing; treating all paths as outside touch-set'
  }

  const base = o.base ?? 'HEAD'
  if (base.startsWith('-'))
    fail(`--base must not start with '-' (got ${JSON.stringify(base)})`)

  const mergeBaseR = mustOk(
    sh(exec, cwd, env, quiet, 'git', ['merge-base', base, 'HEAD']),
    'git merge-base',
  )
  const mergeBase = mergeBaseR.stdout.trim()
  if (!mergeBase) fail('git merge-base produced empty output')

  const headStat = mustOk(
    sh(exec, cwd, env, quiet, 'git', ['diff', mergeBase, '--stat']),
    'git diff --stat',
  )
  const untrackedR = mustOk(
    sh(exec, cwd, env, quiet, 'git', [
      'ls-files',
      '--others',
      '--exclude-standard',
    ]),
    'git ls-files',
  )
  const untracked = untrackedR.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const touchSet = new Set(touchPaths)
  const changedTracked = []
  const nameOnly = mustOk(
    sh(exec, cwd, env, quiet, 'git', ['diff', mergeBase, '--name-only']),
    'git diff --name-only',
  )
  for (const f of nameOnly.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    changedTracked.push(f)
  }
  const allChanged = [...new Set([...changedTracked, ...untracked])]
  const inTouch = allChanged.filter((f) => touchSet.has(f))
  const outside = allChanged.filter((f) => !touchSet.has(f))

  const touchDiffParts = []
  if (touchPaths.length) {
    const td = mustOk(
      sh(exec, cwd, env, quiet, 'git', [
        'diff',
        mergeBase,
        '--',
        ...touchPaths,
      ]),
      'git diff touch-set',
    )
    const t = stripAnsi(td.stdout).trim()
    if (t) touchDiffParts.push(t)
  }
  for (const f of untracked) {
    if (!touchSet.has(f)) continue
    const d = mustOkDiffNoIndex(
      sh(exec, cwd, env, quiet, 'git', [
        'diff',
        '--no-index',
        '--',
        '/dev/null',
        f,
      ]),
      `git diff --no-index ${f}`,
    )
    const body = stripAnsi(d.stdout || d.stderr).trim()
    if (body) touchDiffParts.push(body)
  }

  const outsideStatParts = []
  if (outside.length) {
    const trackedOutside = outside.filter((f) => !untracked.includes(f))
    if (trackedOutside.length) {
      const od = mustOk(
        sh(exec, cwd, env, quiet, 'git', [
          'diff',
          mergeBase,
          '--stat',
          '--',
          ...trackedOutside,
        ]),
        'git diff --stat outside touch-set',
      )
      const t = stripAnsi(od.stdout).trim()
      if (t) outsideStatParts.push(t)
    }
    const untrackedOutside = outside.filter((f) => untracked.includes(f))
    if (untrackedOutside.length) {
      outsideStatParts.push(untrackedOutside.map((f) => `?? ${f}`).join('\n'))
    }
  }

  const untrackedBlock = untracked.length
    ? `Untracked:\n${untracked.map((f) => `?? ${f}`).join('\n')}`
    : ''
  const statBits = [stripAnsi(headStat.stdout).trim(), untrackedBlock]
    .filter(Boolean)
    .join('\n')

  const checklistIds = readReviewChecklistIds(root)
  const brief = {
    slug,
    changePath,
    rules,
    rulesNote: rules.length
      ? null
      : 'pass --rules-json from openspec instructions',
    checklistIds,
    base,
    mergeBase,
    diffStat: statBits || '(empty)',
    touchSetPaths: touchPaths,
    touchNote,
    inTouchSet: inTouch,
    outsideTouchSet: outside,
    touchDiff: touchDiffParts.join('\n\n') || '(empty)',
    outsideDiff: capOutsideTouchPreview(
      outsideStatParts.join('\n') || '(empty)',
    ),
    untracked,
  }
  if (o.out) {
    const outAbs = path.isAbsolute(o.out) ? o.out : path.join(cwd, o.out)
    fs.mkdirSync(path.dirname(outAbs), { recursive: true })
    fs.writeFileSync(outAbs, fmtBrief(brief) + '\n', 'utf8')
    brief.outPath = outAbs
  }
  return brief
}

export function cmdInstructions(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  const artifact = o._[1]
  if (!artifact) fail('usage: pnpm agent instructions <artifact> [--change S]')
  let change = o.change
  if (!change) {
    const br = mustOk(
      sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current']),
      'git branch',
    )
    change = slugFromBranch(br.stdout.trim())
  }
  const instructions = loadArtifactInstructions(root, artifact, change)
  return { ok: true, change, artifact, ...instructions }
}

export function cmdArchive(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  let slug = o.change
  if (!slug) {
    const br = mustOk(
      sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current']),
      'git branch',
    )
    slug = slugFromBranch(br.stdout.trim())
  }
  if (!slug) fail('usage: pnpm agent archive [--change S]')
  const result = archiveOpenSpecChange(root, slug)
  return {
    ok: true,
    slug,
    ...result,
    summary: result.archivedTo
      ? `archived to ${result.archivedTo}`
      : result.removed
        ? `removed openspec/changes/${slug}`
        : `no change dir for ${slug}`,
  }
}

export function cmdStats(o, deps) {
  const { cwd } = deps
  const rel = o._[1]
  if (!rel) fail('usage: pnpm agent stats <path>')
  const filePath = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
  const rounds = loadStatsRounds(filePath)
  const summary = summarizeStats(rounds)
  return {
    ok: statsExitCode(summary) === 0,
    ...summary,
  }
}

export function cmdSize(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  let slug = o.change
  if (!slug) {
    const br = mustOk(
      sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current']),
      'git branch',
    )
    slug = slugFromBranch(br.stdout.trim())
  }
  if (o.plan) {
    const plan = checkPlanSize({ root, changeSlug: slug })
    return {
      ok: true,
      mode: 'plan',
      slug,
      total: plan.total,
      max: DIFF_SIZE_MAX,
      skipped: Boolean(plan.skipped),
      overMax: Boolean(plan.overMax),
      summary:
        plan.reason ||
        `plan size ${plan.total} (target ≤1000, prefer ≤${DIFF_SIZE_MAX}; advisory)`,
    }
  }
  const size = computeDiffSize({ root, warnOnly: true })
  return {
    ok: true,
    mode: 'diff',
    slug,
    lines: size.lines,
    max: size.max,
    warnAt: size.warnAt,
    skipped: Boolean(size.skipped),
    overMax: Boolean(size.overMax),
    summary:
      size.reason ||
      `${size.lines} changed lines (target ≤${size.warnAt}, prefer ≤${size.max}; advisory)`,
  }
}

export function cmdManualQa(o, deps) {
  const { root, cwd, env, exec, quiet } = deps
  let slug = o.change
  if (!slug) {
    try {
      const br = mustOk(
        sh(exec, cwd, env, quiet, 'git', ['branch', '--show-current']),
        'git branch',
      )
      slug = slugFromBranch(br.stdout.trim())
    } catch {
      slug = undefined
    }
  }
  const args = [path.join(root, 'scripts', 'manual-qa.mjs')]
  if (slug) args.push('--change', slug)
  if (o['base-url']) args.push('--base-url', o['base-url'])
  const r = sh(exec, cwd, env, quiet, process.execPath, args)
  const text = `${r.stdout}\n${r.stderr}`.trim()
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  return {
    ok: r.code === 0,
    slug,
    lines,
    summary: lines.join('\n'),
  }
}

function fmtPreflight(r) {
  const ruleList = r.instructions.rules
  const goalLines = Array.isArray(r.item.goal)
    ? r.item.goal.map((g) => `goal: ${g}`)
    : [`goal: ${r.item.goal}`]
  const lines = [
    `ok: ${r.ok}`,
    `branch: ${r.branch}`,
    `slug: ${r.item.slug}`,
    `tag: ${r.item.tag}`,
    `title: ${r.item.title}`,
    `file: ${r.item.file}`,
    `milestone: ${r.item.milestone}`,
    ...goalLines,
    `skips: ${r.skips.join(',')}`,
    `touchSet: ${r.touchSet}`,
    `checklistIds: ${r.checklistIds.join(',')}`,
    `prepFastTrack: ${Boolean(r.prepFastTrack)}`,
    `instructions: rules=${ruleList.length} (use --json for template/rules)`,
    `runCard.ready: ${(r.runCard?.ready ?? []).join(',') || '(none)'}`,
  ]
  if (r.staleWarning) lines.push(`staleWarning: ${r.staleWarning}`)
  if (r.runCard?.artifacts) {
    for (const id of r.runCard.ready ?? []) {
      const art = r.runCard.artifacts[id]
      const n = Array.isArray(art?.rules) ? art.rules.length : 0
      lines.push(`--- runCard artifact: ${id} (rules=${n}) ---`)
      if (art?.template) lines.push(String(art.template).trimEnd())
      if (Array.isArray(art?.rules)) {
        for (const rule of art.rules) lines.push(`- ${rule}`)
      }
    }
  }
  if (r.runCard?.procedure) {
    lines.push('--- apply/archive procedure ---')
    lines.push(String(r.runCard.procedure).trimEnd())
  }
  return lines.join('\n')
}

function fmtInstructions(r) {
  const lines = [
    `ok: ${r.ok}`,
    `change: ${r.change}`,
    `artifact: ${r.artifact}`,
    '--- template ---',
    String(r.template ?? '').trimEnd(),
    '--- rules ---',
  ]
  if (Array.isArray(r.rules)) {
    for (const rule of r.rules) lines.push(`- ${rule}`)
  }
  return lines.join('\n')
}

function fmtStats(r) {
  const lines = [
    `ok: ${r.ok}`,
    `rounds: ${r.rounds.length}`,
    `peakContext: ${r.peakContext}`,
    `firstInput: ${r.firstInput}`,
    `modelCalls: ${r.modelCalls}`,
  ]
  if (r.estimated) {
    lines.push(
      'note: token fields marked estimated use content chars/3.3 (no signatures/metadata)',
    )
  }
  r.rounds.forEach((row, i) => {
    const est = row.estimated ? ' estimated=true' : ''
    lines.push(
      `round[${i}]: input=${row.input} output=${row.output} cacheRead=${row.cacheRead} modelCalls=${row.modelCalls} context=${row.context}${est}`,
    )
  })
  return lines.join('\n')
}

function fmtFinish(r) {
  return [
    `ok: ${r.ok}`,
    `stage: ${r.stage}`,
    `pushAttempts: ${r.pushAttempts}`,
    `branch: ${r.branch}`,
    `ahead: ${r.ahead}`,
    `pr: ${r.prUrl}`,
    `created: ${r.created}`,
    `stampCurrent: ${r.stampCurrent}`,
    `summary: ${r.summary}`,
  ].join('\n')
}

function fmtStampGreen(r) {
  return [
    `ok: ${r.ok}`,
    `stamp: ${r.stamp}`,
    `path: ${r.path}`,
    `summary: ${r.summary}`,
  ].join('\n')
}

function fmtBrief(r) {
  return [
    `slug: ${r.slug}`,
    `changePath: ${r.changePath}`,
    `base: ${r.base}`,
    `mergeBase: ${r.mergeBase}`,
    `rules: ${JSON.stringify(r.rules)}`,
    `rulesNote: ${r.rulesNote}`,
    `checklistIds: ${(r.checklistIds ?? []).join(',')}`,
    '--- diff --stat ---',
    String(r.diffStat),
    `touchNote: ${r.touchNote}`,
    `touchSet: ${r.touchSetPaths.join(', ')}`,
    `inTouchSet: ${r.inTouchSet.join(', ')}`,
    '--- touch-set diff ---',
    String(r.touchDiff),
    '--- outsideTouchSet ---',
    r.outsideTouchSet.join(', '),
    '--- outsideTouchSet stat ---',
    String(r.outsideDiff),
  ].join('\n')
}

function fmtSize(r) {
  return [
    `ok: ${r.ok}`,
    `mode: ${r.mode}`,
    `slug: ${r.slug}`,
    r.mode === 'plan' ? `total: ${r.total}` : `lines: ${r.lines}`,
    `max: ${r.max}`,
    `summary: ${r.summary}`,
  ].join('\n')
}

function fmtManualQa(r) {
  return [`ok: ${r.ok}`, `slug: ${r.slug}`, ...r.lines].join('\n')
}

export function run(argv, deps = {}) {
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const exec = deps.exec ?? defaultExec
  let o
  try {
    o = parseArgs(argv)
    const quiet = wantQuiet(o, env)
    const [cmd] = o._
    if (!cmd || cmd === 'help' || o.help)
      return { code: cmd || o.help ? 0 : 2, out: HELP }
    const allowsArg = cmd === 'instructions' || cmd === 'stats'
    if (o._.length > 1 && !allowsArg) fail(`unexpected argument: ${o._[1]}`)
    if (o._.length > 2) fail(`unexpected argument: ${o._[2]}`)
    const root = path.resolve(cwd, o.root ?? '.')
    const d = { ...deps, root, cwd, env, exec, quiet }
    let r
    let code = 0
    switch (cmd) {
      case 'preflight':
        r = cmdPreflight(o, d)
        break
      case 'finish':
        r = cmdFinish(o, d)
        code = r.ok ? 0 : 1
        break
      case 'stamp-green':
        r = cmdStampGreen(o, d)
        break
      case 'review-brief':
        r = cmdReviewBrief(o, d)
        break
      case 'size':
        r = cmdSize(o, d)
        code = r.ok ? 0 : 1
        break
      case 'manual-qa':
        r = cmdManualQa(o, d)
        code = r.ok ? 0 : 1
        break
      case 'instructions':
        r = cmdInstructions(o, d)
        break
      case 'archive':
        r = cmdArchive(o, d)
        break
      case 'stats':
        r = cmdStats(o, d)
        code = statsExitCode(r)
        break
      default:
        fail(`unknown command: ${cmd}\n${HELP}`)
    }
    const out = o.json
      ? JSON.stringify(r)
      : cmd === 'preflight'
        ? fmtPreflight(r)
        : cmd === 'finish'
          ? fmtFinish(r)
          : cmd === 'stamp-green'
            ? fmtStampGreen(r)
            : cmd === 'instructions'
              ? fmtInstructions(r)
              : cmd === 'stats'
                ? fmtStats(r)
                : cmd === 'size'
                  ? fmtSize(r)
                  : cmd === 'manual-qa'
                    ? fmtManualQa(r)
                    : cmd === 'archive'
                      ? [
                          `ok: ${r.ok}`,
                          `slug: ${r.slug}`,
                          `summary: ${r.summary}`,
                        ].join('\n')
                      : fmtBrief(r)
    return { code, out }
  } catch (e) {
    if (!(e instanceof AgentError)) throw e
    return {
      code: e.exitCode,
      err: o?.json
        ? JSON.stringify({ error: e.message })
        : `error: ${e.message}`,
    }
  }
}

export function main(argv, io) {
  const r = run(argv)
  if (r.out) io.stdout.write(r.out + '\n')
  if (r.err) io.stderr.write(r.err + '\n')
  io.exitCode = r.code
}
