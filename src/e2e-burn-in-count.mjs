#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadGates } from './load-gates.mjs'

const BURN_IN_RE = /^Burn-in:\s*(\d+)\s*$/m
const BRANCH_SLUG_RE = /^(?:feat|fix)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/

export function parseBurnInLine(text) {
  const match = BURN_IN_RE.exec(String(text))
  if (!match) return null
  return Number(match[1])
}

export function slugFromBranch(branch) {
  if (!branch) return null
  const match = BRANCH_SLUG_RE.exec(String(branch).trim())
  return match ? match[1] : null
}

export function findRoadmapItemPath(root, slug) {
  if (!slug) return null
  const roadmapDir = join(root, 'docs', 'roadmap')
  if (!existsSync(roadmapDir)) return null

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'archive') continue
        const found = walk(full)
        if (found !== null) return found
        continue
      }
      if (entry.name === `${slug}.md`) return full
    }
    return null
  }

  return walk(roadmapDir)
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   branch?: string | null,
 *   root?: string,
 *   readItemFile?: (path: string) => string,
 *   findItemPath?: (root: string, slug: string) => string | null,
 *   loadGatesFn?: typeof loadGates,
 * }} [opts]
 */
export function resolveBurnInCount(opts = {}) {
  const env = opts.env ?? process.env
  const root = opts.root ?? process.cwd()
  const readItemFile =
    opts.readItemFile ?? ((path) => readFileSync(path, 'utf8'))
  const findItemPath = opts.findItemPath ?? findRoadmapItemPath
  const load = opts.loadGatesFn ?? loadGates

  const raw = env.E2E_BURN_IN
  const base =
    raw === undefined || raw === ''
      ? load({ root }).e2e.burnInDefault
      : Number(raw)
  if (!Number.isInteger(base) || base < 1) {
    throw new Error(
      `E2E_BURN_IN must be a positive integer, got ${String(raw)}`,
    )
  }

  const branch =
    opts.branch ?? env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME ?? null
  const slug = slugFromBranch(branch)
  if (!slug) return base

  const itemPath = findItemPath(root, slug)
  if (!itemPath) return base

  let text = ''
  try {
    text = readItemFile(itemPath)
  } catch {
    return base
  }

  const declared = parseBurnInLine(text)
  if (declared === null || declared < 1) return base
  return Math.max(declared, base)
}

export function main(opts = {}) {
  const count = resolveBurnInCount(opts)
  const line = `${String(count)}\n`
  if (typeof opts.write === 'function') opts.write(line)
  else process.stdout.write(line)
  return 0
}
