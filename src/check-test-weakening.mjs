/**
 * Test-level weakening + item-criteria helpers for gate ratchet.
 * Parses file text only (TypeScript AST) — never executes head code.
 */
import path from 'node:path'
import ts from 'typescript'

export const WEAKENING_SUFFIXES = Object.freeze([
  'skip',
  'only',
  'todo',
  'fixme',
  'fail',
])

export const TEST_ROOT_NAMES = Object.freeze(['test', 'it', 'describe'])
export const TEST_ROOT_TEST = 'test'
export const TEST_ROOT_IT = 'it'
export const TEST_ROOT_DESCRIBE = 'describe'
export const TEST_CONFIGURE = 'configure'

export const OWNER_APPROVAL_PREFIX = 'Owner-approved scope change:'

export const PATHS = Object.freeze({
  winSep: '\\',
  posixSep: '/',
  nodeModules: 'node_modules/',
  burnInFixtures: '/burn-in-fixtures/',
  srcPrefix: 'src/',
  scriptsPrefix: 'scripts/',
  e2ePrefix: 'e2e/',
  testDot: '.test.',
  extTs: '.ts',
  extTsx: '.tsx',
  extMjs: '.mjs',
  extJs: '.js',
  specTsSuffix: '.spec.ts',
  roadmapPrefix: 'docs/roadmap/',
  mdSuffix: '.md',
  introBase: 'INTRO',
  readmeBase: 'README',
  indexTs: '/index.ts',
})

export const RETRIES_KEY = 'retries'

export const STATUS_PREFIX = 'Status:'
export const STATUS_DONE = 'Status: done'
export const DONE_NOTE_H2 = '## Done note'
export const DONE_NOTE_PREFIX = 'Done note:'
export const DEFAULT_PARSE_FILENAME = 'file.ts'

export const CHECKBOX_TODO = '- [ ]'
export const CHECKBOX_DONE = '- [x]'

export const CONFIG_KEYS = Object.freeze({
  allowOnly: 'allowOnly',
  forbidOnly: 'forbidOnly',
  viteConfig: 'vite.config.ts',
  playwrightConfig: 'playwright.config.ts',
  falseLit: 'false',
  trueLit: 'true',
})

/** Fail-message fragments — exact values pinned by unit tests. */
export const MSGS = Object.freeze({
  testFileDeletedPrefix: 'test file deleted without companion source: ',
  weakeningAddedPrefix: 'weakening marker added in ',
  retriesAddedPrefix: 'retries added in ',
  allowOnlyWeakerPrefix: 'vite allowOnly weakened: ',
  forbidOnlyWeakerPrefix: 'playwright forbidOnly weakened: ',
  weakerArrow: ' → ',
  itemLoosenedPrefix: 'roadmap item criteria loosened: ',
  deferralAddedPrefix: 'deferral roadmap item added: ',
  ruleTestFileDeleted: 'test-file-deleted',
  ruleTestSkipAdded: 'test-skip-added',
  ruleTestRetriesAdded: 'test-retries-added',
  ruleAllowOnlyWeaker: 'allow-only-weaker',
  ruleForbidOnlyWeaker: 'forbid-only-weaker',
  ruleItemCriteria: 'item-criteria-loosened',
})

export const CRITERIA = Object.freeze({
  doneWhenH2: '## Done when',
  scopeH2: '## Scope',
  doneWhenBullet: '- **Done when:**',
  sizeBullet: '- **Size:**',
  checkboxOpen: '- [',
})

export const COMPANION_EXTS = Object.freeze([
  PATHS.extTs,
  PATHS.extTsx,
  PATHS.extMjs,
  PATHS.extJs,
])

/**
 * @param {unknown} v
 * @returns {string}
 */
export function coerceText(v) {
  if (v == null) return ''
  return typeof v === 'string' ? v : String(v)
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isTrackedTestPath(rel) {
  const p = rel.replaceAll(PATHS.winSep, PATHS.posixSep)
  if (p.includes(PATHS.nodeModules) || p.includes(PATHS.burnInFixtures)) {
    return false
  }
  const isVitestSrc =
    p.startsWith(PATHS.srcPrefix) &&
    p.includes(PATHS.testDot) &&
    (p.endsWith(PATHS.extTs) ||
      p.endsWith(PATHS.extTsx) ||
      p.endsWith(PATHS.extMjs))
  const isScriptTest =
    p.startsWith(PATHS.scriptsPrefix) &&
    p.includes(PATHS.testDot) &&
    (p.endsWith(PATHS.extMjs) ||
      p.endsWith(PATHS.extJs) ||
      p.endsWith(PATHS.extTs))
  const isE2e = p.startsWith(PATHS.e2ePrefix) && p.endsWith(PATHS.specTsSuffix)
  return isVitestSrc || isScriptTest || isE2e
}

/**
 * Companion source paths that justify deleting a test file.
 * @param {string} testPath
 * @returns {string[]}
 */
export function companionPathsFor(testPath) {
  const p = testPath.replaceAll(PATHS.winSep, PATHS.posixSep)
  const dir = path.posix.dirname(p)
  const base = path.posix.basename(p)
  /** @type {string[]} */
  const out = []
  let stem = null
  const testMatch = /^(.*)\.test\.(ts|tsx|mjs|js)$/.exec(base)
  const specMatch = /^(.*)\.spec\.(ts|tsx)$/.exec(base)
  if (testMatch) stem = testMatch[1]
  else if (specMatch) stem = specMatch[1]
  if (stem != null) {
    for (const ext of COMPANION_EXTS) {
      out.push(path.posix.join(dir, `${stem}${ext}`))
    }
  }
  if (p.startsWith(PATHS.e2ePrefix) && stem != null) {
    out.push(
      `${PATHS.srcPrefix}${stem}${PATHS.extTs}`,
      `${PATHS.srcPrefix}${stem}${PATHS.extTsx}`,
      `${PATHS.srcPrefix}${stem}${PATHS.indexTs}`,
    )
  }
  return [...new Set(out)]
}

/**
 * True when any companion path for `testPath` exists on base and is absent on head.
 * For e2e specs, also accept any deleted src file whose basename matches the stem.
 * @param {string} testPath
 * @param {Record<string, string | undefined>} baseFiles
 * @param {Record<string, string | undefined>} headFiles
 * @returns {boolean}
 */
export function companionDeletedFor(testPath, baseFiles, headFiles) {
  const companions = companionPathsFor(testPath)
  if (
    companions.some(
      (c) => baseFiles[c] !== undefined && headFiles[c] === undefined,
    )
  ) {
    return true
  }
  const p = testPath.replaceAll(PATHS.winSep, PATHS.posixSep)
  if (!p.startsWith(PATHS.e2ePrefix) || !p.endsWith(PATHS.specTsSuffix)) {
    return false
  }
  const stem = path.posix.basename(p, PATHS.specTsSuffix).toLowerCase()
  for (const key of Object.keys(baseFiles)) {
    const rel = key.replaceAll(PATHS.winSep, PATHS.posixSep)
    if (!rel.startsWith(PATHS.srcPrefix)) continue
    if (headFiles[rel] !== undefined) continue
    const base = path.posix.basename(rel).toLowerCase()
    if (base === stem || base.startsWith(`${stem}.`)) return true
  }
  return false
}

/**
 * @param {ts.Expression} expr
 * @returns {string[]}
 */
export function calleeParts(expr) {
  /** @type {string[]} */
  const parts = []
  let cur = expr
  while (cur) {
    if (ts.isIdentifier(cur)) {
      parts.unshift(cur.text)
      break
    }
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text)
      cur = cur.expression
      continue
    }
    break
  }
  return parts
}

/**
 * @param {ts.Expression | undefined} expr
 * @returns {string | null}
 */
export function staticStringArg(expr) {
  if (!expr) return null
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text
  }
  return null
}

/**
 * @param {ts.Node | undefined} node
 * @returns {boolean}
 */
export function objectHasRetries(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = prop.name
    if (ts.isIdentifier(name) && name.text === RETRIES_KEY) return true
    if (ts.isStringLiteral(name) && name.text === RETRIES_KEY) return true
  }
  return false
}

/**
 * @param {ts.Expression | undefined} expr
 * @param {ts.SourceFile} sf
 * @returns {string}
 */
/**
 * @param {string} source
 * @param {string} fileName
 * @returns {{
 *   weakening: { suffix: string, title: string | null }[],
 *   retries: number,
 * }}
 */
export function parseTestFile(source, fileName = DEFAULT_PARSE_FILENAME) {
  const text = coerceText(source)
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(PATHS.extTsx) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  /** @type {{ suffix: string, title: string | null }[]} */
  const weakening = []
  let retries = 0

  /**
   * @param {ts.Node} node
   */
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const parts = calleeParts(node.expression)
      const root = parts[0]
      if (!TEST_ROOT_NAMES.includes(root)) {
        ts.forEachChild(node, visit)
        return
      }

      const weak = parts.find((p) => WEAKENING_SUFFIXES.includes(p))
      const title = staticStringArg(node.arguments[0])

      if (weak) {
        weakening.push({ suffix: weak, title })
      }

      if (
        parts.includes(TEST_CONFIGURE) &&
        objectHasRetries(node.arguments[0])
      ) {
        retries += 1
      }

      const isTestOrIt =
        (root === TEST_ROOT_TEST || root === TEST_ROOT_IT) &&
        !parts.includes(TEST_ROOT_DESCRIBE) &&
        !parts.includes(TEST_CONFIGURE)
      if (isTestOrIt) {
        const bodyArg = node.arguments[1]
        if (bodyArg && objectHasRetries(bodyArg)) {
          if (!weak) retries += 1
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return { weakening, retries }
}

/**
 * Extract a boolean config key written as `key: true|false`.
 * @param {string} source
 * @param {string} key
 * @returns {'true' | 'false' | 'other' | null}
 */
export function extractConfigBool(source, key) {
  const src = coerceText(source)
  const re = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}/]+)`, 'm')
  const m = re.exec(src)
  if (!m) return null
  const raw = m[1].trim()
  if (raw === 'true') return 'true'
  if (raw === 'false') return 'false'
  return 'other'
}

/**
 * @param {string} prBody
 * @returns {boolean}
 */
export function hasOwnerApprovedScopeChange(prBody) {
  const lines = coerceText(prBody).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith(OWNER_APPROVAL_PREFIX)) continue
    if (line.slice(OWNER_APPROVAL_PREFIX.length).trim().length > 0) return true
    // Bare prefix line: following non-empty lines are the reason body.
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) break
      return true
    }
  }
  return false
}

/**
 * @param {string} branch
 * @returns {string | null}
 */
export function slugFromBranch(branch) {
  const m = /^(?:feat|fix)\/([^/]+)$/.exec(coerceText(branch).trim())
  return m ? m[1] : null
}

/**
 * @param {string} baseText
 * @param {string} headText
 * @returns {boolean}
 */
export function isAllowedItemEdit(baseText, headText) {
  const base = coerceText(baseText).replaceAll('\r\n', '\n').split('\n')
  const head = coerceText(headText).replaceAll('\r\n', '\n').split('\n')
  let bi = 0
  let hi = 0
  let inDoneNote = false
  while (bi < base.length && hi < head.length) {
    const b = base[bi]
    const h = head[hi]
    if (b === h) {
      bi++
      hi++
      continue
    }
    if (
      b.startsWith(CHECKBOX_TODO) &&
      h.startsWith(CHECKBOX_DONE) &&
      b.slice(CHECKBOX_TODO.length) === h.slice(CHECKBOX_DONE.length)
    ) {
      bi++
      hi++
      continue
    }
    if (
      b.startsWith(STATUS_PREFIX) &&
      b.slice(STATUS_PREFIX.length).trim().length > 0 &&
      h === STATUS_DONE
    ) {
      bi++
      hi++
      continue
    }
    // Insert Status: done when base had no Status line (roadmap done).
    if (h === STATUS_DONE && !b.startsWith(STATUS_PREFIX)) {
      hi++
      continue
    }
    return false
  }
  if (bi < base.length) return false
  while (hi < head.length) {
    const h = head[hi]
    if (!inDoneNote) {
      // Blank lines before the note do not open note mode (probe: blank + Done when).
      if (h.trim() === '') {
        hi++
        continue
      }
      if (h === DONE_NOTE_H2 || h.startsWith(DONE_NOTE_PREFIX)) {
        inDoneNote = true
        hi++
        continue
      }
      return false
    }
    // Inside Done note: reject Scope / Done-when / Size reopenings.
    if (isItemCriteriaLine(h)) return false
    hi++
  }
  return true
}

/**
 * Lines that must not appear after a Done note starts (self-loosening probes).
 * @param {string} line
 * @returns {boolean}
 */
export function isItemCriteriaLine(line) {
  const h = coerceText(line)
  if (h.startsWith(CRITERIA.doneWhenH2)) return true
  if (h.startsWith(CRITERIA.scopeH2)) return true
  if (h.startsWith(CRITERIA.doneWhenBullet)) return true
  if (h.startsWith(CRITERIA.sizeBullet)) return true
  if (h.startsWith(CRITERIA.checkboxOpen)) return true
  return false
}

/**
 * @param {string} text
 * @param {string} slug
 * @returns {boolean}
 */
export function isDeferralRoadmapText(text, slug) {
  const t = coerceText(text)
  if (slug && t.includes(slug)) return true
  const defers = /\b(defer|follow-?up|instead of meeting)\b/i.test(t)
  const bar = /\b(coverage|mutation|NoCoverage|e2e)\b/i.test(t)
  return defers && bar
}

/**
 * @param {Record<string, string | undefined>} files
 * @returns {string[]}
 */
export function listTrackedTestPaths(files) {
  return Object.keys(files)
    .map((p) => p.replaceAll(PATHS.winSep, PATHS.posixSep))
    .filter(isTrackedTestPath)
    .sort()
}

/**
 * @param {Record<string, string | undefined>} baseFiles
 * @param {Record<string, string | undefined>} headFiles
 * @param {(ruleId: string, message: string) => void} fail
 */
export function compareTestWeakening(baseFiles, headFiles, fail) {
  const paths = new Set([
    ...listTrackedTestPaths(baseFiles),
    ...listTrackedTestPaths(headFiles),
  ])

  for (const p of paths) {
    const bRaw = baseFiles[p]
    const hRaw = headFiles[p]
    if (bRaw !== undefined && hRaw === undefined) {
      if (!companionDeletedFor(p, baseFiles, headFiles)) {
        fail(MSGS.ruleTestFileDeleted, `${MSGS.testFileDeletedPrefix}${p}`)
      }
      continue
    }
    if (bRaw === undefined || hRaw === undefined) continue
    if (bRaw === hRaw) continue

    const b = parseTestFile(bRaw, p)
    const h = parseTestFile(hRaw, p)

    const bSuffixCounts = countBySuffix(b.weakening)
    const hSuffixCounts = countBySuffix(h.weakening)
    for (const suffix of WEAKENING_SUFFIXES) {
      if ((hSuffixCounts.get(suffix) ?? 0) > (bSuffixCounts.get(suffix) ?? 0)) {
        fail(MSGS.ruleTestSkipAdded, `${MSGS.weakeningAddedPrefix}${p}`)
        break
      }
    }

    if (h.retries > b.retries) {
      fail(MSGS.ruleTestRetriesAdded, `${MSGS.retriesAddedPrefix}${p}`)
    }
  }

  const bAllow = extractConfigBool(
    coerceText(baseFiles[CONFIG_KEYS.viteConfig]),
    CONFIG_KEYS.allowOnly,
  )
  const hAllow = extractConfigBool(
    coerceText(headFiles[CONFIG_KEYS.viteConfig]),
    CONFIG_KEYS.allowOnly,
  )
  if (bAllow === CONFIG_KEYS.falseLit && hAllow !== CONFIG_KEYS.falseLit) {
    fail(
      MSGS.ruleAllowOnlyWeaker,
      `${MSGS.allowOnlyWeakerPrefix}${bAllow}${MSGS.weakerArrow}${hAllow}`,
    )
  }

  const bForbid = extractConfigBool(
    coerceText(baseFiles[CONFIG_KEYS.playwrightConfig]),
    CONFIG_KEYS.forbidOnly,
  )
  const hForbid = extractConfigBool(
    coerceText(headFiles[CONFIG_KEYS.playwrightConfig]),
    CONFIG_KEYS.forbidOnly,
  )
  if (bForbid === CONFIG_KEYS.trueLit && hForbid !== CONFIG_KEYS.trueLit) {
    fail(
      MSGS.ruleForbidOnlyWeaker,
      `${MSGS.forbidOnlyWeakerPrefix}${bForbid}${MSGS.weakerArrow}${hForbid}`,
    )
  }
}

/**
 * @param {{ suffix: string }[]} items
 * @returns {Map<string, number>}
 */
function countBySuffix(items) {
  const m = new Map()
  for (const it of items) {
    m.set(it.suffix, (m.get(it.suffix) ?? 0) + 1)
  }
  return m
}

/**
 * @param {Record<string, string | undefined>} baseFiles
 * @param {Record<string, string | undefined>} headFiles
 * @param {{ prBody?: string, branch?: string }} opts
 * @param {(ruleId: string, message: string) => void} fail
 */
export function compareItemCriteria(baseFiles, headFiles, opts, fail) {
  if (hasOwnerApprovedScopeChange(opts.prBody ?? '')) return

  const slug =
    slugFromBranch(opts.branch ?? '') ??
    detectSlugFromChangedItems(baseFiles, headFiles)
  if (!slug) return

  const itemPath = findItemPath(baseFiles, headFiles, slug)
  if (itemPath) {
    const b = baseFiles[itemPath]
    const h = headFiles[itemPath]
    if (b !== undefined && h !== undefined && b !== h) {
      if (!isAllowedItemEdit(b, h)) {
        fail(MSGS.ruleItemCriteria, `${MSGS.itemLoosenedPrefix}${itemPath}`)
      }
    }
  }

  for (const p of Object.keys(headFiles)) {
    const rel = p.replaceAll(PATHS.winSep, PATHS.posixSep)
    if (!rel.startsWith(PATHS.roadmapPrefix) || !rel.endsWith(PATHS.mdSuffix)) {
      continue
    }
    if (baseFiles[rel] !== undefined) continue
    if (
      rel.endsWith(`/${PATHS.introBase}${PATHS.mdSuffix}`) ||
      rel.endsWith(`/${PATHS.readmeBase}${PATHS.mdSuffix}`)
    ) {
      continue
    }
    const baseName = path.posix.basename(rel, PATHS.mdSuffix)
    if (baseName === slug) continue
    if (isDeferralRoadmapText(coerceText(headFiles[rel]), slug)) {
      fail(MSGS.ruleItemCriteria, `${MSGS.deferralAddedPrefix}${rel}`)
    }
  }
}

/**
 * @param {Record<string, string | undefined>} baseFiles
 * @param {Record<string, string | undefined>} headFiles
 * @returns {string | null}
 */
function detectSlugFromChangedItems(baseFiles, headFiles) {
  for (const p of Object.keys(headFiles)) {
    const rel = p.replaceAll(PATHS.winSep, PATHS.posixSep)
    const m = /^docs\/roadmap\/[^/]+\/([^/]+)\.md$/.exec(rel)
    if (!m) continue
    if (m[1] === PATHS.introBase || m[1] === PATHS.readmeBase) continue
    if (baseFiles[rel] !== headFiles[rel]) return m[1]
  }
  return null
}

/**
 * @param {Record<string, string | undefined>} baseFiles
 * @param {Record<string, string | undefined>} headFiles
 * @param {string} slug
 * @returns {string | null}
 */
function findItemPath(baseFiles, headFiles, slug) {
  for (const files of [headFiles, baseFiles]) {
    for (const p of Object.keys(files)) {
      const rel = p.replaceAll(PATHS.winSep, PATHS.posixSep)
      if (
        rel.endsWith(`/${slug}${PATHS.mdSuffix}`) &&
        rel.startsWith(PATHS.roadmapPrefix)
      ) {
        return rel
      }
    }
  }
  return null
}

/**
 * Count weakening markers across a file map.
 * @param {Record<string, string | undefined>} files
 * @returns {number}
 */
export function countWeakeningMarkers(files) {
  let n = 0
  for (const p of listTrackedTestPaths(files)) {
    const raw = files[p]
    if (raw == null) continue
    n += parseTestFile(raw, p).weakening.length
  }
  return n
}
