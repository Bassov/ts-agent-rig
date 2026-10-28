#!/usr/bin/env node
// Roadmap CLI: docs/roadmap.md (index, order = priority) + docs/roadmap/<M>/<slug>.md (one file per item).
// Zero dependencies, Node 22, ESM. `pnpm roadmap help`. Process rules: docs/roadmap/RULES.md.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const INDEX_REL = 'docs/roadmap.md'
export const DIR_REL = 'docs/roadmap'
export const ARCHIVE_REL = 'docs/roadmap/archive'
export const TAGS = ['prep', 'feature', 'contingency', 'lite']
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// - [ ] [tag] [slug](roadmap/M/slug.md) — title      (tag optional)
export const ITEM_RE =
  /^- \[( |x|X)\] (?:\[([a-z][a-z0-9-]*)\] )?\[([^\]\s]+)\]\(([^)\s]+)\) — (.+)$/
export const MS_RE = /^## (\S+) — (.+)$/
export const ARCH_RE = /^- \[(\S+) — (.+)\]\(([^)\s]+)\)$/
const SPECIAL_FILES = new Set(['README.md', 'INTRO.md'])

export class RoadmapError extends Error {
  constructor(msg, code = 2) {
    super(msg)
    this.exitCode = code
  }
}
const fail = (m) => {
  throw new RoadmapError(m)
}

export const folderName = (id) => id.replace(/[^A-Za-z0-9._-]/g, '-')
export const itemLink = (msId, slug) => `roadmap/${folderName(msId)}/${slug}.md`
/** @deprecated Legacy git-archive path; check errors if this folder still exists. */
export const archiveLink = (msId) =>
  `roadmap/archive/${folderName(msId)}/README.md`
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/')
const MIGRATE_ARCHIVE =
  'finished milestones are retired (roadmap archive <M> deletes the folder); remove ## Archive and docs/roadmap/archive/ — git history is SoT'

// ---------- fs helpers ----------
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}` // never ends in .md, so listings skip it
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile()
const listDirs = (p) =>
  isDir(p)
    ? fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : []
/** item files of an existing folder */
const listItemFiles = (p) =>
  fs
    .readdirSync(p)
    .filter((f) => f.endsWith('.md') && !SPECIAL_FILES.has(f))
    .sort()

// ---------- index parsing ----------
// The index is kept as an array of lines (text.split('\n')); every edit is a splice,
// so untouched lines (and the trailing newline) are preserved byte-for-byte.
export function parseIndex(text) {
  const lines = text.split('\n')
  const milestones = [],
    items = [],
    archived = [],
    problems = []
  let ms = null,
    kind = 'header',
    archiveStart = null
  lines.forEach((l, i) => {
    const bad = (msg) => problems.push({ line: i, msg })
    if (l.startsWith('## ')) {
      if (ms) ms.end = i
      const m = MS_RE.exec(l)
      ms = m
        ? {
            id: m[1],
            title: m[2],
            start: i,
            end: lines.length,
            goal: [],
            items: [],
          }
        : null
      if (ms) milestones.push(ms)
      kind = ms ? 'milestone' : l === '## Archive' ? 'archive' : 'other'
      if (kind === 'archive') archiveStart = i
      return
    }
    if (l.trim() === '') return
    if (kind === 'archive') {
      const a = ARCH_RE.exec(l)
      if (a) archived.push({ line: i, id: a[1], title: a[2], link: a[3] })
      else bad('unexpected line in ## Archive')
      return
    }
    if (kind !== 'milestone') {
      if (/^\s*- \[[ xX]\]/.test(l)) bad('item line outside a milestone')
      return
    }
    const m = ITEM_RE.exec(l)
    if (m) {
      const it = {
        line: i,
        done: m[1] !== ' ',
        tag: m[2] || null,
        slug: m[3],
        link: m[4],
        title: m[5],
        milestone: ms.id,
      }
      ms.items.push(it)
      items.push(it)
    } else if (/^\s/.test(l))
      bad('indented (nested) line in index; index entries must be single-line')
    else if (l.startsWith('- [')) bad('malformed item line')
    else if (ms.items.length)
      bad('non-item line after items; index entries must be single-line')
    else ms.goal.push(l)
  })
  return { lines, milestones, items, archived, archiveStart, problems }
}

const itemAbs = (ctx, link) => path.join(ctx.root, 'docs', link)
/** Apply item-file Status + legacy index [x] as done SoT. */
export function enrichItems(ctx) {
  for (const it of ctx.items) {
    const f = itemAbs(ctx, it.link)
    it.indexDone = it.done
    it.fileDone = isFile(f) && fileStatusDone(fs.readFileSync(f, 'utf8'))
    it.done = it.indexDone || it.fileDone
  }
  return ctx
}
export function load(root) {
  const indexPath = path.join(root, INDEX_REL)
  if (!isFile(indexPath))
    fail(`index not found: ${indexPath} (use --root <repo>)`)
  return enrichItems({
    root,
    indexPath,
    ...parseIndex(fs.readFileSync(indexPath, 'utf8')),
  })
}
const reparse = (ctx, lines) =>
  enrichItems({ ...ctx, ...parseIndex(lines.join('\n')) })

/** slug -> { file, folder } for every item file under docs/roadmap/archive/<F>/ */
export function archivedItems(root) {
  const res = new Map()
  const base = path.join(root, ARCHIVE_REL)
  for (const f of listDirs(base))
    for (const file of listItemFiles(path.join(base, f))) {
      const slug = file.slice(0, -3)
      if (!res.has(slug)) res.set(slug, [])
      res.get(slug).push({ folder: f, file: path.join(base, f, file) })
    }
  return res
}

// ---------- item files ----------
export function renderItemFile({ slug, tag, milestone, title, body, status }) {
  let s = `# ${slug}\n\nTag: ${tag || 'none'}\nMilestone: ${milestone}\nTitle: ${title}\n`
  if (status) s += `Status: ${status}\n`
  if (body && body.length) s += `\n## Scope\n\n${body.join('\n')}\n`
  return s
}
export function parseItemFile(text) {
  const heading = /^# (.*)/.exec(text.split('\n')[0])
  const f = (k) => new RegExp(`^${k}: (.*)`, 'm').exec(text)?.[1] ?? null
  return {
    heading: heading ? heading[1] : null,
    tag: f('Tag'),
    milestone: f('Milestone'),
    title: f('Title'),
    status: f('Status'),
  }
}
export function fileStatusDone(text) {
  const s = parseItemFile(text).status
  return s !== null && /^done$/i.test(s.trim())
}
/** Insert or replace Status header line. */
export function withFileStatus(text, done) {
  const line = `Status: ${done ? 'done' : 'open'}`
  if (/^Status:\s*/m.test(text)) return text.replace(/^Status:\s*.*$/m, line)
  if (/^Title:\s*.*$/m.test(text))
    return text.replace(/^(Title:\s*.*)$/m, `$1\n${line}`)
  return `${text.replace(/\n*$/, '\n')}${line}\n`
}
/** item file content minus the metadata header (already printed by next/show) */
export function stripMeta(text) {
  const lines = text.split('\n')
  let i = 0
  while (
    i < lines.length &&
    (lines[i].trim() === '' ||
      (/^# /.test(lines[i]) && i === 0) ||
      /^(Tag|Milestone|Title|Status): /.test(lines[i]))
  )
    i++
  return lines.slice(i).join('\n').replace(/\n+$/, '')
}
/** Item bodies were nested under the top-level checkbox; the file has no parent list item, so drop one level. */
export const dedent = (l) => (l.startsWith('  ') ? l.slice(2) : l)
function defaultBody(tag) {
  const b = ['- [ ] TODO: scope']
  if (tag === 'prep' || tag === 'lite') b.push('- **Done when:** TODO')
  if (tag === 'feature') b.push('- **Browser check:** TODO')
  return b
}

// ---------- positions ----------
function findMilestone(ctx, id) {
  const ms = ctx.milestones.find((m) => m.id === id)
  if (ms) return ms
  if (ctx.archived.some((a) => a.id === id))
    fail(`milestone ${id}: ${MIGRATE_ARCHIVE}`)
  fail(`unknown milestone: ${id}`)
}
function findItem(ctx, slug, what = 'slug') {
  const it = ctx.items.find((i) => i.slug === slug)
  if (it) return it
  fail(`unknown ${what}: ${slug}`)
}
/** -> { milestone, index (insert before), pad (needs blank line before), desc } */
export function resolvePosition(ctx, o) {
  const anchors = [o.after, o.before].filter((x) => x !== undefined)
  if (anchors.length > 1) fail('use only one of --after / --before')
  if (o.top && o.bottom) fail('use only one of --top / --bottom')
  if (!anchors.length && o.milestone === undefined)
    fail(
      'position required: --after <slug> | --before <slug> | --milestone <M> [--top|--bottom]',
    )
  if (anchors.length && (o.top || o.bottom))
    fail('--top/--bottom only go with --milestone (without --after/--before)')
  if (anchors.length) {
    const a = anchors[0]
    const anc = findItem(ctx, a, 'anchor')
    if (o.milestone !== undefined && o.milestone !== anc.milestone)
      fail(`anchor ${a} is in ${anc.milestone}, not ${o.milestone}`)
    return {
      milestone: anc.milestone,
      index: o.after !== undefined ? anc.line + 1 : anc.line,
      pad: false,
      desc: `${o.after !== undefined ? 'after' : 'before'} ${a}`,
    }
  }
  const ms = findMilestone(ctx, o.milestone)
  if (!ms.items.length) {
    let last = ms.start
    for (let i = ms.start; i < ms.end; i++) if (ctx.lines[i].trim()) last = i
    return {
      milestone: ms.id,
      index: last + 1,
      pad: true,
      desc: `${ms.id} (only item)`,
    }
  }
  if (o.top)
    return {
      milestone: ms.id,
      index: ms.items[0].line,
      pad: false,
      desc: `${ms.id} top`,
    }
  return {
    milestone: ms.id,
    index: ms.items.at(-1).line + 1,
    pad: false,
    desc: `${ms.id} bottom`,
  }
}
const insertLine = (lines, pos, line) => [
  ...lines.slice(0, pos.index),
  ...(pos.pad ? ['', line] : [line]),
  ...lines.slice(pos.index),
]
export const itemLine = ({ done, tag, slug, link, title }) =>
  `- [${done ? 'x' : ' '}] ${tag ? `[${tag}] ` : ''}[${slug}](${link}) — ${title}`

// ---------- archive (retire) ----------
/**
 * Retire a fully-done milestone: drop its index block and delete docs/roadmap/<F>/.
 * Does not write docs/roadmap/archive/ — git history is SoT.
 */
export function archiveMilestone(ctx, msId) {
  const ms = findMilestone(ctx, msId)
  const F = folderName(ms.id)
  const src = path.join(ctx.root, DIR_REL, F)
  const lines = [...ctx.lines.slice(0, ms.start), ...ctx.lines.slice(ms.end)]
  while (lines.length > 1 && lines.at(-1) === '' && lines.at(-2) === '')
    lines.pop()
  if (lines.at(-1) !== '') lines.push('')
  if (isDir(src)) fs.rmSync(src, { recursive: true, force: true })
  return {
    lines,
    removed: rel(ctx.root, src),
    milestone: ms.id,
  }
}
const writeIndex = (ctx, lines) => atomicWrite(ctx.indexPath, lines.join('\n'))

// ---------- commands ----------
function itemView(ctx, it, withBody) {
  const ms = ctx.milestones.find((m) => m.id === it.milestone)
  const file = itemAbs(ctx, it.link)
  const v = {
    slug: it.slug,
    tag: it.tag,
    status: it.done ? 'done' : 'open',
    milestone: it.milestone,
    milestoneTitle: ms.title,
    goal: ms.goal.map((g) => g.replace(/\]\(roadmap\//g, '](docs/roadmap/')),
    title: it.title,
    file: rel(ctx.root, file),
  }
  if (withBody)
    v.body = isFile(file) ? stripMeta(fs.readFileSync(file, 'utf8')) : null
  return v
}
export function assertOpenItem(ctx, slug, o = {}) {
  if (!slug) fail('slug required')
  const it = ctx.items.find((i) => i.slug === slug)
  if (!it) fail(`unknown slug: ${slug}`)
  if (it.done) fail(`already done: ${slug}`)
  if (it.tag === 'contingency' && !o.includeContingency)
    fail(
      `${slug} is a [contingency]: pass --include-contingency (or pick it only when its gate failed)`,
    )
  return it
}
export function cmdNext(ctx, o = {}) {
  if (o.slug) {
    const it = assertOpenItem(ctx, o.slug, o)
    if (o.tag && it.tag !== o.tag)
      fail(`slug ${o.slug} has tag ${it.tag ?? 'none'}, expected ${o.tag}`)
    return itemView(ctx, it, !o.noBody)
  }
  const skip = new Set(o.skip)
  const it = ctx.items.find(
    (i) =>
      !i.done &&
      (o.includeContingency || i.tag !== 'contingency') &&
      (!o.tag || i.tag === o.tag) &&
      !skip.has(i.slug),
  )
  return it ? itemView(ctx, it, !o.noBody) : null
}
export function cmdClaim(ctx, slug, o = {}) {
  const it = assertOpenItem(ctx, slug, o)
  return { claimed: it.slug, milestone: it.milestone, tag: it.tag }
}
export function cmdShow(ctx, slug, o = {}) {
  const it = ctx.items.find((i) => i.slug === slug)
  if (!it) fail(`unknown slug: ${slug}`)
  return itemView(ctx, it, !o.noBody)
}
export function cmdList(ctx, o = {}) {
  let ms = ctx.milestones
  if (o.milestone !== undefined) ms = [findMilestone(ctx, o.milestone)]
  return {
    milestones: ms.map((m) => ({
      id: m.id,
      title: m.title,
      done: m.items.filter((i) => i.done).length,
      total: m.items.length,
      items: m.items
        .filter((i) => !o.open || !i.done)
        .map((i) => ({
          slug: i.slug,
          tag: i.tag,
          done: i.done,
          title: i.title,
        })),
    })),
  }
}
export function allSlugs(ctx) {
  return new Set(ctx.items.map((i) => i.slug))
}
export function cmdAdd(ctx, slug, o) {
  if (!slug)
    fail(
      'usage: add <slug> --tag <t> --title "..." (--after <slug> | --before <slug> | --milestone <M> [--top|--bottom])',
    )
  if (!SLUG_RE.test(slug)) fail(`bad slug "${slug}": use kebab-case [a-z0-9-]`)
  if (!o.tag) fail(`--tag required (${TAGS.join('|')})`)
  if (!TAGS.includes(o.tag)) fail(`bad tag "${o.tag}": use ${TAGS.join('|')}`)
  const title = (o.title ?? '').trim()
  if (!title) fail('--title required')
  if (/[\r\n]/.test(title)) fail('title must be a single line')
  if (allSlugs(ctx).has(slug)) fail(`slug already exists: ${slug}`)
  if (o.body !== undefined && o.bodyFile !== undefined)
    fail('use only one of --body / --body-file')
  const pos = resolvePosition(ctx, o)
  let body =
    o.body ??
    (o.bodyFile !== undefined
      ? fs.readFileSync(path.resolve(o.cwd || '.', o.bodyFile), 'utf8')
      : null)
  body =
    body === null ? defaultBody(o.tag) : body.replace(/\s+$/, '').split('\n')
  const link = itemLink(pos.milestone, slug)
  const file = itemAbs(ctx, link)
  if (fs.existsSync(file)) fail(`file already exists: ${rel(ctx.root, file)}`)
  const lines = insertLine(
    ctx.lines,
    pos,
    itemLine({ done: false, tag: o.tag, slug, link, title }),
  )
  atomicWrite(
    file,
    renderItemFile({ slug, tag: o.tag, milestone: pos.milestone, title, body }),
  )
  try {
    writeIndex(ctx, lines)
  } catch (e) {
    fs.rmSync(file, { force: true })
    throw e
  }
  return {
    added: slug,
    milestone: pos.milestone,
    position: pos.desc,
    file: rel(ctx.root, file),
  }
}
export function cmdDone(ctx, slug, o = {}) {
  if (!slug) fail('usage: done <slug> [--note "..."]')
  const note = o.note === undefined ? null : o.note.trim()
  if (note !== null && (!note || /[\r\n]/.test(note)))
    fail('--note must be one non-empty line')
  const it = ctx.items.find((i) => i.slug === slug)
  if (!it) fail(`unknown slug: ${slug}`)
  if (it.done) fail(`already done: ${slug}`)
  if (it.tag === 'contingency' && note === null)
    fail(
      `${slug} is a [contingency]: close it with --note (e.g. "not needed (gate passed in \`<gate-item>\`)")`,
    )
  const f = itemAbs(ctx, it.link)
  let text = withFileStatus(fs.readFileSync(f, 'utf8'), true)
  if (note !== null)
    text = `${text.replace(/\n*$/, '\n')}\n## Done note\n\n${note}\n`
  atomicWrite(f, text)
  const c = load(ctx.root)
  const ms = c.milestones.find((m) => m.id === it.milestone)
  return {
    done: slug,
    milestone: ms.id,
    progress: `${ms.items.filter((i) => i.done).length}/${ms.items.length}`,
    note,
    archived: null,
    indexTicked: false,
  }
}
/** Tick index checkboxes for items that are file-done but index-open. */
export function cmdSync(ctx) {
  const lines = [...ctx.lines]
  const ticked = []
  for (const it of ctx.items) {
    if (it.fileDone && !it.indexDone) {
      lines[it.line] = lines[it.line].replace('- [ ]', '- [x]')
      ticked.push(it.slug)
    }
  }
  if (ticked.length) writeIndex(ctx, lines)
  return { ticked, count: ticked.length }
}
/** Retire a fully-done milestone (post-merge operator step): drop index block + delete folder. */
export function cmdArchive(ctx, msId) {
  if (!msId) fail('usage: archive <milestone>')
  const ms = findMilestone(ctx, msId)
  if (!ms.items.length) fail(`milestone ${msId} has no items`)
  if (!ms.items.every((i) => i.done))
    fail(
      `milestone ${msId} has open items: ${ms.items
        .filter((i) => !i.done)
        .map((i) => i.slug)
        .join(', ')}`,
    )
  const synced = cmdSync(ctx)
  const c = synced.count ? load(ctx.root) : ctx
  const a = archiveMilestone(c, msId)
  writeIndex(c, a.lines)
  return {
    archived: a.milestone,
    removed: a.removed,
    ticked: synced.ticked,
  }
}
export function cmdMove(ctx, slug, o) {
  if (!slug)
    fail(
      'usage: move <slug> (--after <slug> | --before <slug> | --milestone <M> [--top|--bottom])',
    )
  const it = findItem(ctx, slug)
  if (o.after === slug || o.before === slug)
    fail('cannot move an item relative to itself')
  const c = reparse(
    ctx,
    ctx.lines.filter((_, i) => i !== it.line),
  )
  const pos = resolvePosition(c, o)
  const cross = pos.milestone !== it.milestone
  if (cross) {
    const srcMs = c.milestones.find((m) => m.id === it.milestone)
    if (!srcMs.items.some((i) => !i.done))
      fail(
        `moving ${slug} would leave ${it.milestone} with no open items (finish or add items first)`,
      )
  }
  const link = cross ? itemLink(pos.milestone, slug) : it.link
  const lines = insertLine(c.lines, pos, itemLine({ ...it, link }))
  if (cross) {
    const from = itemAbs(ctx, it.link),
      to = itemAbs(ctx, link)
    if (fs.existsSync(to)) fail(`target file exists: ${rel(ctx.root, to)}`)
    const text = fs
      .readFileSync(from, 'utf8')
      .replace(/^Milestone: .*/m, `Milestone: ${pos.milestone}`)
    atomicWrite(to, text)
    try {
      writeIndex(ctx, lines)
    } catch (e) {
      fs.rmSync(to, { force: true })
      throw e
    }
    fs.rmSync(from)
  } else writeIndex(ctx, lines)
  return {
    moved: slug,
    from: it.milestone,
    to: pos.milestone,
    position: pos.desc,
    file: rel(ctx.root, itemAbs(ctx, link)),
  }
}

export function cmdCheck(ctx) {
  const E = []
  const W = []
  const L = (i) => `${INDEX_REL}:${i + 1}`
  for (const p of ctx.problems) E.push(`single-line: ${L(p.line)}: ${p.msg}`)
  const seen = new Map()
  const ids = new Map()
  for (const m of ctx.milestones) ids.set(m.id, (ids.get(m.id) || 0) + 1)
  for (const [id, n] of ids)
    if (n > 1) E.push(`milestone: ${id} appears ${n} times in the index`)
  for (const it of ctx.items) {
    if (seen.has(it.slug))
      E.push(
        `unique: ${L(it.line)}: duplicate slug ${it.slug} (also ${L(seen.get(it.slug))})`,
      )
    else seen.set(it.slug, it.line)
    if (!SLUG_RE.test(it.slug))
      E.push(`slug: ${L(it.line)}: bad slug ${it.slug}`)
    const want = itemLink(it.milestone, it.slug)
    if (it.link !== want)
      E.push(
        `link: ${L(it.line)}: ${it.slug} links ${it.link}, expected ${want}`,
      )
    const f = itemAbs(ctx, it.link)
    if (!isFile(f)) {
      E.push(`file: ${L(it.line)}: ${it.slug}: missing file docs/${it.link}`)
      continue
    }
    const meta = parseItemFile(fs.readFileSync(f, 'utf8'))
    if (meta.heading !== it.slug)
      E.push(
        `heading: docs/${it.link}: heading "# ${meta.heading}" does not match slug ${it.slug}`,
      )
    if (meta.milestone !== it.milestone)
      E.push(
        `heading: docs/${it.link}: Milestone "${meta.milestone}" but index has ${it.milestone}`,
      )
    if ((meta.tag === 'none' ? null : meta.tag) !== it.tag)
      E.push(
        `meta: docs/${it.link}: Tag "${meta.tag}" but index has ${it.tag ?? 'none'}`,
      )
    if (meta.title !== it.title)
      E.push(
        `meta: docs/${it.link}: Title differs from index line ${L(it.line)}`,
      )
    if (it.fileDone && !it.indexDone)
      W.push(
        `sync: ${it.slug} is Status: done but index still open (run roadmap sync)`,
      )
  }
  for (const m of ctx.milestones) {
    if (!m.items.length) E.push(`milestone: ${m.id} has no items`)
    else if (m.items.every((i) => i.done))
      W.push(
        `archive: ${m.id} is fully done but still active (run roadmap archive ${m.id})`,
      )
  }
  if (ctx.archiveStart !== null || ctx.archived.length)
    E.push(`archive: ## Archive section must be removed (${MIGRATE_ARCHIVE})`)
  if (isDir(path.join(ctx.root, ARCHIVE_REL)))
    E.push(`archive: ${ARCHIVE_REL}/ must not exist (${MIGRATE_ARCHIVE})`)
  const base = path.join(ctx.root, DIR_REL)
  const activeFolders = new Map(
    ctx.milestones.map((m) => [folderName(m.id), m.id]),
  )
  for (const d of listDirs(base)) {
    if (d === 'archive') continue
    if (!activeFolders.has(d)) {
      E.push(`orphan: ${DIR_REL}/${d}/ is not an active milestone folder`)
      continue
    }
    for (const f of listItemFiles(path.join(base, d))) {
      const link = `roadmap/${d}/${f}`
      const n = ctx.items.filter((i) => i.link === link).length
      if (n !== 1)
        E.push(`orphan: docs/${link} has ${n} index lines (expected 1)`)
    }
  }
  return {
    ok: E.length === 0,
    errors: E,
    warnings: W,
    items: ctx.items.length,
    open: ctx.items.filter((i) => !i.done).length,
    milestones: ctx.milestones.length,
    archived: 0,
  }
}

// ---------- migration ----------
/** Parse the monolithic roadmap. Item = top-level `- [ ]` line + every following line up to the next
 *  top-level item or `## ` heading (trailing blank lines dropped). Milestone intro = lines between the
 *  heading and the first item. */
export function parseSource(text) {
  const lines = text.split('\n')
  const header = [],
    sections = []
  let cur = null,
    item = null
  const closeItem = () => {
    if (item) {
      while (item.body.length && item.body.at(-1).trim() === '') item.body.pop()
      item = null
    }
  }
  lines.forEach((l, i) => {
    if (l.startsWith('## ')) {
      closeItem()
      const m = MS_RE.exec(l)
      cur = m
        ? {
            kind: 'milestone',
            id: m[1],
            title: m[2],
            heading: l,
            intro: [],
            items: [],
            line: i,
          }
        : {
            kind: 'other',
            heading: l,
            title: l.slice(3),
            lines: [],
            items: [],
            line: i,
          }
      sections.push(cur)
      return
    }
    if (!cur) {
      header.push(l)
      return
    }
    const top = /^- \[([ xX])\] (.*)/.exec(l)
    if (cur.kind === 'milestone' && top) {
      closeItem()
      item = {
        ...parseHeadline(top[2]),
        done: top[1] !== ' ',
        headline: l,
        line: i,
        body: [],
        milestone: cur.id,
      }
      cur.items.push(item)
      return
    }
    if (item) item.body.push(l)
    else if (cur.kind === 'milestone') cur.intro.push(l)
    else cur.lines.push(l)
  })
  closeItem()
  // generate slugs for untagged items without one
  const used = new Set(
    sections
      .flatMap((s) => s.items)
      .map((i) => i.slug)
      .filter(Boolean),
  )
  for (const s of sections)
    for (const it of s.items) {
      if (it.slug) continue
      let base = genSlug(it.title),
        slug = base,
        n = 2
      while (used.has(slug)) slug = `${base}-${n++}`
      used.add(slug)
      it.slug = slug
      it.generatedSlug = true
    }
  return { header, sections }
}
export function parseHeadline(rest) {
  let tag = null,
    slug = null,
    title = rest
  const t = /^\[([a-z][a-z0-9-]*)\] (.*)/.exec(title)
  if (t) {
    tag = t[1]
    title = t[2]
  }
  const s = /^`([^`]+)`(?: — (.*))?$/.exec(title)
  if (s && SLUG_RE.test(s[1])) {
    slug = s[1]
    title = s[2] ?? s[1]
  }
  return { tag, slug, title }
}
export function genSlug(title) {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter(Boolean)
  return words.slice(0, 5).join('-') || 'item'
}

export const INDEX_NOTE =
  'Process: [roadmap/RULES.md](roadmap/RULES.md). One file per item: `roadmap/<milestone>/<slug>.md`. Retire a finished milestone with `pnpm roadmap archive <M>` (drops the index block and folder; git history is SoT). Change the index only with `pnpm roadmap` (`add` / `done` / `move` / `sync` / `archive`), never by hand.'
/** Owner-approved header rewrites applied by migrate (old sentence start -> new). */
export const HEADER_REWRITES = [
  [
    'This file is the single source of truth',
    'This index and the item files under `docs/roadmap/` are the single source of truth',
  ],
]
/** Owner-approved body rewrites applied by migrate: the old monolith said "this file". */
export const BODY_REWRITES = [
  [
    '"Change size" in this file',
    '"Change size" in the roadmap rules (`docs/roadmap/RULES.md`)',
  ],
]
export const rewriteBody = (l) =>
  BODY_REWRITES.reduce((acc, [a, b]) => acc.split(a).join(b), l)
const rewriteHeader = (l) =>
  HEADER_REWRITES.reduce(
    (acc, [a, b]) => (acc.startsWith(a) ? b + acc.slice(a.length) : acc),
    l,
  )

export function cmdMigrate(source, root, o = {}) {
  const text = fs.readFileSync(source, 'utf8')
  const src = parseSource(text)
  const indexPath = path.join(root, INDEX_REL)
  if (fs.existsSync(indexPath) && !o.force)
    fail(`${INDEX_REL} exists in ${root} (use --force to overwrite)`)
  if (o.force)
    fs.rmSync(path.join(root, DIR_REL), { recursive: true, force: true })
  const out = []
  const header = src.header
  while (header.at(-1) === '') header.pop()
  out.push(...header.map(rewriteHeader), '', INDEX_NOTE, '')
  const rules = ['# Roadmap rules', '']
  const rewritten = new Set()
  let deferred = null
  let files = 0
  for (const s of src.sections) {
    if (s.kind === 'other') {
      const body = s.lines
      while (body.at(-1) === '') body.pop()
      if (/^how to use$/i.test(s.title)) {
        if (o.rulesFile) for (const l of [s.heading, ...body]) rewritten.add(l)
        else rules.push(s.heading, ...body, '')
        continue
      }
      if (/^deferred/i.test(s.title)) {
        deferred = s
        atomicWrite(
          path.join(root, DIR_REL, 'DEFERRED.md'),
          [`# ${s.title}`, ...body, ''].join('\n'),
        )
        files++
        out.push(
          s.heading,
          '',
          'Not scheduled, not items: [roadmap/DEFERRED.md](roadmap/DEFERRED.md). To schedule one, the owner asks for an `add`.',
          '',
        )
        continue
      }
      out.push(s.heading, ...body, '') // e.g. ## Order — kept verbatim (short)
      continue
    }
    const F = folderName(s.id)
    const intro = s.intro.filter((l) => l.trim() !== '')
    out.push(s.heading, '')
    if (intro.length) {
      if (intro.length <= 3)
        out.push(...intro.flatMap((l, k) => (k ? ['', l] : [l])))
      else {
        out.push(intro[0], '', `Notes: [INTRO.md](roadmap/${F}/INTRO.md)`)
        const notes = [`# ${s.id} — notes`, '']
        intro.slice(1).forEach((l, k) => {
          if (k) notes.push('')
          notes.push(l)
        })
        atomicWrite(
          path.join(root, DIR_REL, F, 'INTRO.md'),
          notes.join('\n') + '\n',
        )
        files++
      }
      out.push('')
    }
    for (const it of s.items) {
      const link = itemLink(s.id, it.slug)
      out.push(
        itemLine({
          done: it.done,
          tag: it.tag,
          slug: it.slug,
          link,
          title: it.title,
        }),
      )
      atomicWrite(
        path.join(root, 'docs', link),
        renderItemFile({
          slug: it.slug,
          tag: it.tag,
          milestone: s.id,
          title: it.title,
          body: it.body.map((l) => rewriteBody(dedent(l))),
        }),
      )
      files++
    }
    out.push('')
  }
  while (out.length && out.at(-1) === '') out.pop()
  out.push('')
  atomicWrite(indexPath, out.join('\n'))
  while (rules.at(-1) === '') rules.pop()
  atomicWrite(
    path.join(root, DIR_REL, 'RULES.md'),
    o.rulesFile ? fs.readFileSync(o.rulesFile) : rules.join('\n') + '\n',
  )
  files++
  // Fully-done milestones stay active; operator retires them with `archive <M>`.
  const verify = verifyMigration(src, text, root, { rewritten })
  const items = src.sections.flatMap((s) => s.items)
  return {
    items: items.length,
    done: items.filter((i) => i.done).length,
    open: items.filter((i) => !i.done).length,
    milestones: src.sections.filter((s) => s.kind === 'milestone').length,
    archived: [],
    generatedSlugs: items.filter((i) => i.generatedSlug).map((i) => i.slug),
    filesWritten: files,
    indexBytes: fs.statSync(indexPath).size,
    verify,
  }
}

/** Content preservation: every non-empty body line of every source item must appear in its item file;
 *  headline fields must match; every other non-empty source line must appear verbatim in some output file. */
export function verifyMigration(
  src,
  text,
  root,
  { rewritten = new Set() } = {},
) {
  let rewrittenLines = 0
  const ctx = load(root)
  const missing = []
  let bodyLines = 0,
    globalLines = 0
  const allOut = new Set()
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else for (const l of fs.readFileSync(p, 'utf8').split('\n')) allOut.add(l)
    }
  }
  walk(path.join(root, DIR_REL))
  for (const l of ctx.lines) allOut.add(l)
  const indexAndReadmes = new Map()
  for (const it of ctx.items) indexAndReadmes.set(it.slug, it)
  for (const s of src.sections)
    for (const it of s.items) {
      const active = ctx.items.find((i) => i.slug === it.slug)
      const file = active ? itemAbs(ctx, active.link) : null
      if (!file || !isFile(file)) {
        missing.push(`${it.slug}: no item file`)
        continue
      }
      const content = fs.readFileSync(file, 'utf8')
      const fileLines = new Set(content.split('\n'))
      const meta = parseItemFile(content)
      if (
        meta.heading !== it.slug ||
        meta.title !== it.title ||
        (meta.tag === 'none' ? null : meta.tag) !== it.tag ||
        meta.milestone !== s.id
      )
        missing.push(`${it.slug}: metadata mismatch`)
      const entry = indexAndReadmes.get(it.slug)
      if (
        !entry ||
        entry.done !== it.done ||
        entry.title !== it.title ||
        entry.tag !== it.tag
      )
        missing.push(`${it.slug}: index/README line mismatch`)
      for (const l of it.body)
        if (l.trim() !== '') {
          bodyLines++
          const want = rewriteBody(dedent(l))
          if (want !== dedent(l)) rewrittenLines++
          if (!fileLines.has(want))
            missing.push(`${it.slug}: body line not found: ${l.slice(0, 80)}`)
        }
    }
  const bodySet = new Set(
    src.sections.flatMap((s) => s.items.flatMap((i) => i.body)),
  ) // verified per item above
  for (const l of text.split('\n')) {
    if (l.trim() === '' || /^- \[[ xX]\] /.test(l) || bodySet.has(l)) continue
    if (rewritten.has(l)) {
      rewrittenLines++
      continue
    }
    globalLines++
    const r = rewriteHeader(l)
    if (r !== l) {
      rewrittenLines++
      if (!allOut.has(r))
        missing.push(`rewritten header line not found: ${r.slice(0, 80)}`)
      continue
    }
    if (!allOut.has(l))
      missing.push(`line not found anywhere: ${l.slice(0, 80)}`)
  }
  return {
    ok: missing.length === 0,
    itemsChecked: src.sections.reduce((n, s) => n + s.items.length, 0),
    bodyLines,
    otherLines: globalLines,
    rewrittenLines,
    missing,
  }
}

// ---------- CLI ----------
const BOOL = new Set([
  'json',
  'open',
  'top',
  'bottom',
  'no-body',
  'include-contingency',
  'force',
  'help',
])
const VALUE = new Set([
  'root',
  'skip',
  'slug',
  'milestone',
  'tag',
  'title',
  'after',
  'before',
  'body',
  'body-file',
  'note',
  'rules-file',
])
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
const HELP = `usage: pnpm roadmap <cmd> [--root <repo>] [--json]
  next [--slug S] [--tag T] [--skip a,b] [--include-contingency] [--no-body]   current item (first open, or explicit slug / tag filter)
  show <slug> [--no-body]                                 one item
  list [--milestone M] [--open]                           one line per item
  claim <slug> [--include-contingency]                    validate open slug for preflight hold
  add <slug> --tag prep|feature|contingency|lite --title "..." (--after S | --before S | --milestone M [--top|--bottom]) [--body "..." | --body-file F]
  done <slug> [--note "..."]                              mark Status: done in the item file (no index tick; required note for [contingency])
  sync                                                    tick index [x] from item-file Status: done (post-merge)
  archive <M>                                             retire a fully-done milestone: drop index block + delete folder (post-merge)
  move <slug> (--after S | --before S | --milestone M [--top|--bottom])
  check                                                   consistency (exit 1 on errors; warnings for pending sync/archive)
  migrate <source.md> [--rules-file RULES.md] [--force]   one-off conversion into <root>/docs/`

function fmtItem(v) {
  const o = [
    `slug: ${v.slug}`,
    `tag: ${v.tag ?? 'none'}`,
    `status: ${v.status}`,
    `milestone: ${v.milestone}${v.milestoneTitle ? ` — ${v.milestoneTitle}` : ''}`,
  ]
  for (const g of v.goal) o.push(`goal: ${g}`)
  o.push(`title: ${v.title}`, `file: ${v.file}`)
  if (v.body !== undefined) o.push('---', v.body ?? '(file missing)')
  return o.join('\n')
}
export const textFormat = {
  next: (r) => (r ? fmtItem(r) : 'next: none (no open item)'),
  show: fmtItem,
  list: (r) =>
    r.milestones
      .flatMap((m) => [
        `${m.id} — ${m.title} (${m.done}/${m.total} done)`,
        ...m.items.map(
          (i) =>
            `[${i.done ? 'x' : ' '}] ${i.slug}${i.tag ? ` (${i.tag})` : ''} — ${i.title}`,
        ),
      ])
      .join('\n'),
  add: (r) =>
    `added ${r.added} to ${r.milestone} (${r.position}); file ${r.file}`,
  done: (r) =>
    `done ${r.done} (${r.milestone} ${r.progress})` +
    (r.note !== null ? `\nnote: ${r.note}` : ''),
  claim: (r) =>
    r.tag
      ? `claimed ${r.claimed} (${r.milestone}, ${r.tag})`
      : `claimed ${r.claimed} (${r.milestone})`,
  sync: (r) =>
    r.count
      ? `synced ${r.count} index tick(s): ${r.ticked.join(', ')}`
      : 'sync: nothing to tick',
  archive: (r) => {
    const head = `retired ${r.archived} (removed ${r.removed})`
    return r.ticked?.length
      ? `${head}\nsynced ticks: ${r.ticked.join(', ')}`
      : head
  },
  move: (r) =>
    `moved ${r.moved} ${r.from === r.to ? `within ${r.to}` : `${r.from} -> ${r.to}`} (${r.position}); file ${r.file}`,
  check: (r) => {
    const warn = r.warnings.map((w) => `warning: ${w}`)
    if (r.ok) {
      const head = `check ok: ${r.items} items (${r.open} open), ${r.milestones} active milestones`
      return warn.length ? [head, ...warn].join('\n') : head
    }
    return [
      ...r.errors,
      ...warn,
      `check failed: ${r.errors.length} error(s)`,
    ].join('\n')
  },
  migrate: (r) =>
    [
      `migrated ${r.items} items (${r.done} done, ${r.open} open) in ${r.milestones} milestones; ${r.filesWritten} files`,
      `generated slugs: ${r.generatedSlugs.join(', ') || 'none'}`,
      `index: ${r.indexBytes} bytes`,
      `verify: ${r.verify.ok ? 'ok' : 'FAILED'} (${r.verify.itemsChecked} items, ${r.verify.bodyLines} body lines, ${r.verify.otherLines} other lines, ${r.verify.rewrittenLines} rewritten by owner decision)`,
      ...r.verify.missing,
    ].join('\n'),
}
const fmt = textFormat

export function run(argv, { cwd = process.cwd() } = {}) {
  let o
  try {
    o = parseArgs(argv)
    const [cmd, arg, extra] = o._
    if (!cmd || cmd === 'help' || o.help)
      return { code: cmd || o.help ? 0 : 2, out: HELP }
    if (extra !== undefined) fail(`unexpected argument: ${extra}`)
    const root = path.resolve(cwd, o.root ?? '.')
    const pos = {
      after: o.after,
      before: o.before,
      milestone: o.milestone,
      top: !!o.top,
      bottom: !!o.bottom,
    }
    let r,
      code = 0
    switch (cmd) {
      case 'next':
        r = cmdNext(load(root), {
          slug: o.slug,
          tag: o.tag,
          skip: (o.skip ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          includeContingency: !!o['include-contingency'],
          noBody: !!o['no-body'],
        })
        break
      case 'show':
        if (!arg) fail('usage: show <slug>')
        r = cmdShow(load(root), arg, { noBody: !!o['no-body'] })
        break
      case 'list':
        r = cmdList(load(root), { milestone: o.milestone, open: !!o.open })
        break
      case 'claim':
        if (!arg) fail('usage: claim <slug>')
        r = cmdClaim(load(root), arg, {
          includeContingency: !!o['include-contingency'],
        })
        break
      case 'add':
        r = cmdAdd(load(root), arg, {
          ...pos,
          tag: o.tag,
          title: o.title,
          body: o.body,
          bodyFile: o['body-file'],
          cwd,
        })
        break
      case 'done':
        r = cmdDone(load(root), arg, { note: o.note })
        break
      case 'sync':
        r = cmdSync(load(root))
        break
      case 'archive':
        if (!arg) fail('usage: archive <milestone>')
        r = cmdArchive(load(root), arg)
        break
      case 'move':
        r = cmdMove(load(root), arg, pos)
        break
      case 'check':
        r = cmdCheck(load(root))
        code = r.ok ? 0 : 1
        break
      case 'migrate':
        if (!arg) fail('usage: migrate <source.md>')
        r = cmdMigrate(path.resolve(cwd, arg), root, {
          force: !!o.force,
          rulesFile:
            o['rules-file'] === undefined
              ? null
              : path.resolve(cwd, o['rules-file']),
        })
        code = r.verify.ok ? 0 : 1
        break
      default:
        fail(`unknown command: ${cmd}\n${HELP}`)
    }
    return { code, out: o.json ? JSON.stringify(r) : fmt[cmd](r) }
  } catch (e) {
    if (!(e instanceof RoadmapError)) throw e
    return {
      code: e.exitCode,
      err: o?.json
        ? JSON.stringify({ error: e.message })
        : `error: ${e.message}`,
    }
  }
}

/**
 * When `pnpm roadmap check` should re-exec through `check.mjs --run`.
 * Returns null for non-check commands or when already inside the wrapper.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ selfPath?: string, execPath?: string }} [opts]
 * @returns {{ file: string, args: string[], env: NodeJS.ProcessEnv } | null}
 */
export function checkWrapperArgs(argv, env = process.env, opts = {}) {
  if (!Array.isArray(argv) || argv[0] !== 'check') return null
  if (env.PHOTOBOOKS_CHECK_INNER === '1') return null
  const self = opts.selfPath ?? fileURLToPath(import.meta.url)
  const execPath = opts.execPath ?? process.execPath
  const checkJs = path.join(path.dirname(self), 'check.mjs')
  const verbose =
    argv.includes('--verbose') ||
    argv.includes('-v') ||
    env.CHECK_VERBOSE === '1'
  const inner = argv.filter((a) => a !== '--verbose' && a !== '-v')
  return {
    file: execPath,
    args: [
      checkJs,
      ...(verbose ? ['--verbose'] : []),
      '--run',
      'roadmap',
      '--',
      execPath,
      self,
      ...inner,
    ],
    env: { ...env, PHOTOBOOKS_CHECK_INNER: '1' },
  }
}

/** Process entry: prints run() output and sets the exit code. */
export function main(argv, io) {
  const r = run(argv)
  if (r.out) io.stdout.write(r.out + '\n')
  if (r.err) io.stderr.write(r.err + '\n')
  io.exitCode = r.code
}

/**
 * Run the compact check wrapper (spawnSync + exit). Testable via deps.
 * @param {{ file: string, args: string[], env: NodeJS.ProcessEnv }} wrap
 * @param {{ spawnSync?: typeof spawnSync, exit?: (code: number) => void }} [deps]
 */
export function execCheckWrapper(wrap, deps = {}) {
  const spawn = deps.spawnSync ?? spawnSync
  const exit =
    deps.exit ??
    ((code) => {
      process.exit(code)
    })
  const r = spawn(wrap.file, wrap.args, {
    stdio: 'inherit',
    env: wrap.env,
  })
  exit(r.status === null || r.status === undefined ? 1 : r.status)
}

/**
 * CLI bootstrap for this module. Returns whether this process is the entry.
 * @param {string | undefined} [argv1]
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   metaUrl?: string
 *   spawnSync?: typeof spawnSync
 *   exit?: (code: number) => void
 *   mainFn?: typeof main
 *   io?: { stdout: { write: Function }, stderr: { write: Function }, exitCode?: number }
 * }} [deps]
 */
export function bootRoadmapCli(argv1, argv, env, deps = {}) {
  const a1 = argv1 === undefined ? process.argv[1] : argv1
  const av = argv === undefined ? process.argv.slice(2) : argv
  const ev = env === undefined ? process.env : env
  const metaUrl = deps.metaUrl ?? import.meta.url
  if (!a1) return false
  if (path.resolve(a1) !== fileURLToPath(metaUrl)) return false
  const wrap = checkWrapperArgs(av, ev)
  if (wrap) {
    execCheckWrapper(wrap, deps)
    return true
  }
  const mainFn = deps.mainFn ?? main
  mainFn(av, deps.io ?? process)
  return true
}

bootRoadmapCli()
