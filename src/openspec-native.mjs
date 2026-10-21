/**
 * Native OpenSpec change lifecycle (no external `openspec` CLI).
 * Reads rules/templates from openspec/config.yaml via the `yaml` package.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export const OPENSPEC_ARTIFACT_IDS = Object.freeze([
  'proposal',
  'specs',
  'design',
  'tasks',
])

/** Compact templates — Photobooks roadmap-driven (not stock OpenSpec prose). */
export const ARTIFACT_TEMPLATES = Object.freeze({
  proposal: `## Proposal

Roadmap: \`docs/roadmap/<M>/<slug>.md\` (scope / Done when / Browser / Perf SoT).

### Scope out
- …

### Delta / Risk
- …
`,
  design: `## Decisions

1. …

## Touch-set & Test Plan

- Files: …
- Reuse: …
- Tests (unit / PBT / e2e): …
`,
  tasks: `## Implementation

- [ ] 1. …

## Manual test scenarios

1. …
`,
  specs: `## ADDED|MODIFIED Requirements

### Requirement: <name>
The system SHALL …

#### Scenario: <core flow>
- **WHEN** …
- **THEN** …
`,
})

/**
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
export function loadOpenSpecConfig(root) {
  const file = path.join(root, 'openspec', 'config.yaml')
  if (!fs.existsSync(file)) {
    throw new Error(`openspec/config.yaml missing under ${root}`)
  }
  const raw = fs.readFileSync(file, 'utf8')
  const doc = parseYaml(raw)
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('openspec/config.yaml did not parse to an object')
  }
  return /** @type {Record<string, unknown>} */ (doc)
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} artifactId
 * @returns {string[]}
 */
export function rulesForArtifact(config, artifactId) {
  const rules = config?.rules
  if (rules == null || typeof rules !== 'object' || Array.isArray(rules))
    return []
  const rulesObj = /** @type {Record<string, unknown>} */ (rules)
  if (!Object.prototype.hasOwnProperty.call(rulesObj, artifactId)) return []
  const list = rulesObj[artifactId]
  if (!Array.isArray(list)) return null
  return list.map((r) => String(r))
}

/**
 * @param {string} root
 * @param {string} slug
 * @returns {string} change directory
 */
export function ensureOpenSpecChange(root, slug) {
  const dir = path.join(root, 'openspec', 'changes', slug)
  fs.mkdirSync(dir, { recursive: true })
  const meta = path.join(dir, '.openspec.yaml')
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(meta, 'schema: spec-driven\ncreated: native\n', 'utf8')
  }
  return dir
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function specsPresent(dir) {
  if (fs.existsSync(path.join(dir, '.skip-specs'))) return true
  const specsDir = path.join(dir, 'specs')
  if (!fs.existsSync(specsDir)) return false
  /** @type {string[]} */
  const stack = [specsDir]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur) break
    let ents
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of ents) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile() && ent.name.endsWith('.md')) return true
    }
  }
  return false
}

/**
 * @param {string} root
 * @param {string} slug
 * @param {{ prepFastTrack?: boolean }} [opts]
 */
export function openSpecChangeStatus(root, slug, opts = {}) {
  const dir = path.join(root, 'openspec', 'changes', slug)
  const prep = Boolean(opts.prepFastTrack)
  const has = (name) => fs.existsSync(path.join(dir, name))
  const proposalDone = has('proposal.md')
  const designDone = has('design.md') || has('.skip-design')
  const specsDone = specsPresent(dir)
  const tasksDone = has('tasks.md')
  // Prep/contingency fast-track: unlock tasks after proposal (design/specs optional).
  const designOk = designDone || (prep && proposalDone)
  const specsOk = specsDone || (prep && proposalDone)

  /**
   * @param {string} id
   * @param {boolean} done
   * @param {boolean} depsMet
   * @param {string[]} requires
   */
  function art(id, done, depsMet, requires) {
    if (done) {
      return { id, status: 'done', requires, outputPath: outputPathFor(id) }
    }
    if (depsMet) {
      return { id, status: 'ready', requires, outputPath: outputPathFor(id) }
    }
    return {
      id,
      status: 'blocked',
      requires,
      missingDeps: requires.filter((r) => {
        if (r === 'proposal') return !proposalDone
        if (r === 'design') return !designOk
        if (r === 'specs') return !specsOk
        return true
      }),
      outputPath: outputPathFor(id),
    }
  }

  return {
    changeName: slug,
    schemaName: 'spec-driven',
    artifacts: [
      art('proposal', proposalDone, true, []),
      art('specs', specsOk, proposalDone, ['proposal']),
      art('design', designOk, proposalDone, ['proposal']),
      art('tasks', tasksDone, designOk && specsOk, ['specs', 'design']),
    ],
  }
}

/** @param {string} id */
function outputPathFor(id) {
  if (id === 'specs') return 'specs/**/*.md'
  return `${id}.md`
}

/**
 * @param {string} root
 * @param {string} artifactId
 * @returns {{ template: string|null, rules: string[] }}
 */
export function loadNativeArtifactInstructions(root, artifactId) {
  const config = loadOpenSpecConfig(root)
  const template =
    artifactId in ARTIFACT_TEMPLATES
      ? ARTIFACT_TEMPLATES[
          /** @type {keyof typeof ARTIFACT_TEMPLATES} */ (artifactId)
        ]
      : null
  const rules = rulesForArtifact(config, artifactId)
  return {
    template,
    rules,
  }
}

/**
 * Remove (or optionally keep) an OpenSpec change working directory.
 * Default: delete openspec/changes/<slug>. Pass keepArchive:true to rename into
 * openspec/changes/archive/YYYY-MM-DD-<slug>/ (prefer ignoring archive/** in search).
 * @param {string} root
 * @param {string} slug
 * @param {{ date?: string, keepArchive?: boolean, rmOnly?: boolean }} [opts]
 * @returns {{ archivedTo: string|null, removed: boolean }}
 */
export function archiveOpenSpecChange(root, slug, opts = {}) {
  const src = path.join(root, 'openspec', 'changes', slug)
  if (!fs.existsSync(src)) {
    return { archivedTo: null, removed: false }
  }
  if (!opts.keepArchive) {
    fs.rmSync(src, { recursive: true, force: true })
    return { archivedTo: null, removed: true }
  }
  const day = opts.date ?? new Date().toISOString().slice(0, 10)
  const destParent = path.join(root, 'openspec', 'changes', 'archive')
  fs.mkdirSync(destParent, { recursive: true })
  let dest = path.join(destParent, `${day}-${slug}`)
  if (fs.existsSync(dest)) dest = `${dest}-${Date.now()}`
  fs.renameSync(src, dest)
  return {
    archivedTo: path.relative(root, dest).replaceAll('\\', '/'),
    removed: false,
  }
}
