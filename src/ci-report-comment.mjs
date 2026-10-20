#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SECTIONS = ['lighthouse', 'mutation', 'coverage', 'e2e']

const SECTION_TITLES = {
  lighthouse: 'Lighthouse',
  mutation: 'Mutation testing',
  coverage: 'Coverage',
  e2e: 'E2E',
}

const DETAILS_SUMMARY = {
  lighthouse: 'Category scores and links',
  mutation: 'Mutation breakdown',
  coverage: 'Coverage breakdown',
  e2e: 'E2E burn-in and flaky retries',
}

const METRIC_HEADER_LABELS = new Set(['Category', 'Metric'])

const MARKER_START = '<!-- ci-report-comment\n'
const MARKER_END = '\n-->'

const LEGACY_STICKY_HEADERS = [
  '<!-- Sticky Pull Request Commentlighthouse-ci -->',
  '<!-- Sticky Pull Request Commentstryker-mutation -->',
  '<!-- Sticky Pull Request Commentcoverage-summary -->',
]

const JOB_FAILED_REASON = 'Job finished before a report was produced.'
const SKIPPED_REASON = 'No changed files to mutate.'

export function classifySection({
  reportPresent,
  stepOutcome,
  missingReport,
  body = '',
  reason,
}) {
  if (
    reportPresent &&
    (stepOutcome === 'success' || stepOutcome === 'failure')
  ) {
    return {
      kind: 'job-succeeded',
      check: stepOutcome === 'success' ? 'passed' : 'failed',
      body,
    }
  }

  if (
    !reportPresent &&
    stepOutcome === 'success' &&
    missingReport === 'skipped'
  ) {
    return { kind: 'skipped', reason: reason ?? SKIPPED_REASON }
  }

  return { kind: 'job-failed', reason: reason ?? JOB_FAILED_REASON }
}

export function emptyState(headSha) {
  return {
    version: 1,
    headSha,
    sections: {
      lighthouse: { kind: 'waiting' },
      mutation: { kind: 'waiting' },
      coverage: { kind: 'waiting' },
      e2e: { kind: 'waiting' },
    },
  }
}

/** Fill any SECTIONS id missing from a prior marker (e.g. pre-e2e comments). */
export function normalizeState(state, headSha = state?.headSha) {
  const base = emptyState(headSha ?? '')
  if (!state || typeof state !== 'object') return base
  base.headSha = state.headSha ?? headSha ?? ''
  if (typeof state.version === 'number') base.version = state.version
  for (const id of SECTIONS) {
    if (state.sections?.[id]) base.sections[id] = state.sections[id]
  }
  return base
}

export function upsertSection(state, sectionId, section, headSha) {
  if (!SECTIONS.includes(sectionId)) {
    throw new Error(`Unknown section: ${sectionId}`)
  }

  const base =
    state && state.headSha === headSha
      ? normalizeState(structuredClone(state), headSha)
      : emptyState(headSha)
  base.sections[sectionId] = section
  base.headSha = headSha
  return base
}

export function encodeState(state) {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
  return `${MARKER_START}${payload}${MARKER_END}`
}

export function decodeState(body) {
  const start = body.indexOf(MARKER_START)
  if (start === -1) return null
  const from = start + MARKER_START.length
  const end = body.indexOf(MARKER_END, from)
  if (end === -1) return null
  const payload = body.slice(from, end).trim()
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
}

export function shouldWrite(runHeadSha, liveHeadSha) {
  return Boolean(runHeadSha) && runHeadSha === liveHeadSha
}

export function isLegacyStickyComment(body) {
  return LEGACY_STICKY_HEADERS.some((header) => body.includes(header))
}

function sectionMark(section) {
  if (section.kind === 'waiting') return '⏳'
  if (section.kind === 'skipped') return '⏭️'
  if (section.kind === 'job-failed') return '❌'
  return section.check === 'passed' ? '✅' : '⚠️'
}

function statusLine(section) {
  switch (section.kind) {
    case 'waiting':
      return '**Waiting**'
    case 'skipped':
      return `**Skipped** — ${section.reason}`
    case 'job-failed':
      return `**Job failed** — ${section.reason}`
    case 'job-succeeded':
      return section.check === 'passed'
        ? '**Job succeeded · Check passed**'
        : '**Job succeeded · Check failed**'
    default:
      throw new Error(`Unknown section kind: ${section.kind}`)
  }
}

export function metricRows(body) {
  const rows = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length < 2) continue
    const label = cells[0]
    const value = cells[1]
    if (!label || !value) continue
    if (/^:?-+:?$/.test(label) || /^:?-+:?$/.test(value)) continue
    if (METRIC_HEADER_LABELS.has(label)) continue
    rows.push({ label, value: value.replaceAll('**', '') })
  }
  return rows
}

function glanceValue(value) {
  return value.replace(/\s*\([^)]*\)\s*$/, '')
}

function scoreboard(rows) {
  if (rows.length === 0) return []
  return [
    `| ${rows.map((row) => row.label).join(' | ')} |`,
    `| ${rows.map(() => ':---:').join(' | ')} |`,
    `| ${rows.map((row) => `**${glanceValue(row.value)}**`).join(' | ')} |`,
  ]
}

function sectionBlock(sectionId, section) {
  const lines = [
    `### ${sectionMark(section)} ${SECTION_TITLES[sectionId]}`,
    '',
    statusLine(section),
  ]
  if (section.kind !== 'job-succeeded') return lines.join('\n')

  const board = scoreboard(metricRows(section.body ?? ''))
  if (board.length > 0) lines.push('', ...board)
  lines.push(
    '',
    '<details>',
    `<summary>${DETAILS_SUMMARY[sectionId]}</summary>`,
    '',
    (section.body ?? '').trim(),
    '',
    '</details>',
  )
  return lines.join('\n')
}

export function renderComment(state) {
  const normalized = normalizeState(state, state?.headSha)
  const blocks = SECTIONS.map((sectionId) =>
    sectionBlock(sectionId, normalized.sections[sectionId]),
  )

  return [
    encodeState(normalized),
    '',
    '## CI Report',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export function isLighthouseReportFile(name) {
  return name.startsWith('lhr-') && name.endsWith('.json')
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function reportIsPresent(args) {
  if (args.report) return existsSync(args.report)
  if (!args['report-dir']) return false
  if (!existsSync(args['report-dir'])) return false
  return readdirSync(args['report-dir']).some((name) =>
    isLighthouseReportFile(name),
  )
}

function pack(args) {
  const reportPresent = reportIsPresent(args)
  const body =
    reportPresent && args['body-file'] && existsSync(args['body-file'])
      ? readFileSync(args['body-file'], 'utf8')
      : ''
  const section = classifySection({
    reportPresent,
    stepOutcome: args['step-outcome'],
    missingReport: args['missing-report'],
    body,
  })
  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(section)}\n`)
}

function nextLink(header) {
  if (!header) return null
  for (const part of header.split(',')) {
    if (!part.includes('rel="next"')) continue
    const start = part.indexOf('<')
    const end = part.indexOf('>')
    if (start !== -1 && end > start) return part.slice(start + 1, end)
  }
  return null
}

async function github(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub ${response.status} ${url}: ${text}`)
  }
  if (response.status === 204) return { data: null, link: null }
  return { data: await response.json(), link: response.headers.get('link') }
}

async function listComments(token, owner, repo, prNumber) {
  const comments = []
  let url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
  while (url) {
    const page = await github(token, url)
    comments.push(...page.data)
    url = nextLink(page.link)
  }
  return comments
}

async function apply(args) {
  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  const prNumber = process.env.PR_NUMBER
  const runHeadSha = process.env.HEAD_SHA
  if (!token || !repository || !prNumber || !runHeadSha) {
    throw new Error(
      'Required env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA',
    )
  }

  const [owner, repo] = repository.split('/')
  const pull = await github(
    token,
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
  )
  if (!shouldWrite(runHeadSha, pull.data.head.sha)) {
    console.log('Skip CI report comment; pull request head has moved.')
    return
  }

  const section = existsSync(args.artifact)
    ? JSON.parse(readFileSync(args.artifact, 'utf8'))
    : classifySection({
        reportPresent: false,
        stepOutcome: 'failure',
        missingReport: 'job-failed',
      })

  const comments = await listComments(token, owner, repo, prNumber)
  const reports = comments.filter((comment) =>
    comment.body?.includes(MARKER_START),
  )
  const current = reports[0]
  const state = upsertSection(
    current ? decodeState(current.body) : null,
    args.section,
    section,
    runHeadSha,
  )
  const body = renderComment(state)
  const saved = current
    ? await github(
        token,
        `https://api.github.com/repos/${owner}/${repo}/issues/comments/${current.id}`,
        { method: 'PATCH', body: JSON.stringify({ body }) },
      )
    : await github(
        token,
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )

  const savedId = saved.data.id
  for (const comment of comments) {
    if (comment.id === savedId) continue
    const legacy = isLegacyStickyComment(comment.body ?? '')
    const duplicate = comment.body?.includes(MARKER_START)
    if (!legacy && !duplicate) continue
    await github(
      token,
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${comment.id}`,
      { method: 'DELETE' },
    )
  }

  console.log(`Updated ${args.section} section (${section.kind}).`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (command === 'pack') {
    pack(args)
    return
  }
  if (command === 'apply') {
    await apply(args)
    return
  }
  throw new Error('Usage: ci-report-comment.mjs <pack|apply> [options]')
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
