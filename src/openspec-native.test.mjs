import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_TEMPLATES,
  OPENSPEC_ARTIFACT_IDS,
  archiveOpenSpecChange,
  ensureOpenSpecChange,
  loadNativeArtifactInstructions,
  loadOpenSpecConfig,
  openSpecChangeStatus,
  rulesForArtifact,
} from './openspec-native.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

function tmp(config = 'schema: spec-driven\nrules:\n  proposal:\n    - one\n') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-native-'))
  tmpDirs.push(d)
  fs.mkdirSync(path.join(d, 'openspec'), { recursive: true })
  fs.writeFileSync(path.join(d, 'openspec', 'config.yaml'), config)
  return d
}

describe('openspec-native', () => {
  it('exports artifact ids and templates', () => {
    expect(OPENSPEC_ARTIFACT_IDS).toContain('proposal')
    expect(ARTIFACT_TEMPLATES.design).toContain('## Decisions')
    expect(ARTIFACT_TEMPLATES.tasks).toContain('## Manual test scenarios')
    expect(ARTIFACT_TEMPLATES.specs).toContain('SHALL')
  })

  it('ensure + status + instructions + archive', () => {
    const root = tmp()
    const dir = ensureOpenSpecChange(root, 'demo')
    expect(fs.existsSync(path.join(dir, '.openspec.yaml'))).toBe(true)
    ensureOpenSpecChange(root, 'demo') // idempotent meta
    expect(openSpecChangeStatus(root, 'demo').artifacts[0]).toMatchObject({
      id: 'proposal',
      status: 'ready',
    })
    fs.writeFileSync(path.join(dir, 'proposal.md'), 'p\n')
    const after = openSpecChangeStatus(root, 'demo')
    expect(after.artifacts.find((a) => a.id === 'design')?.status).toBe('ready')
    expect(after.artifacts.find((a) => a.id === 'specs')?.status).toBe('ready')
    expect(after.artifacts.find((a) => a.id === 'tasks')?.status).toBe(
      'blocked',
    )
    const instr = loadNativeArtifactInstructions(root, 'proposal')
    expect(instr.rules).toEqual(['one'])
    expect(instr.template).toContain('## Proposal')
    expect(loadNativeArtifactInstructions(root, 'unknown-id').template).toBe(
      null,
    )
    const archived = archiveOpenSpecChange(root, 'demo')
    expect(archived).toEqual({ archivedTo: null, removed: true })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('prep fast-track unlocks tasks after proposal', () => {
    const root = tmp()
    ensureOpenSpecChange(root, 'prep')
    fs.writeFileSync(
      path.join(root, 'openspec', 'changes', 'prep', 'proposal.md'),
      'p\n',
    )
    const st = openSpecChangeStatus(root, 'prep', { prepFastTrack: true })
    expect(st.artifacts.find((a) => a.id === 'tasks')?.status).toBe('ready')
  })

  it('honors .skip-design / .skip-specs and nested specs md', () => {
    const root = tmp()
    const dir = ensureOpenSpecChange(root, 'skips')
    fs.writeFileSync(path.join(dir, 'proposal.md'), 'p\n')
    fs.writeFileSync(path.join(dir, '.skip-design'), '')
    fs.mkdirSync(path.join(dir, 'specs', 'cap'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'specs', 'cap', 'spec.md'), '# x\n')
    const st = openSpecChangeStatus(root, 'skips')
    expect(st.artifacts.find((a) => a.id === 'design')?.status).toBe('done')
    expect(st.artifacts.find((a) => a.id === 'specs')?.status).toBe('done')
    expect(st.artifacts.find((a) => a.id === 'tasks')?.status).toBe('ready')
    fs.writeFileSync(path.join(dir, 'tasks.md'), 't\n')
    expect(
      openSpecChangeStatus(root, 'skips').artifacts.find(
        (a) => a.id === 'tasks',
      )?.status,
    ).toBe('done')
  })

  it('archive default remove and keepArchive collision path', () => {
    const root = tmp()
    expect(archiveOpenSpecChange(root, 'gone')).toEqual({
      archivedTo: null,
      removed: false,
    })
    const dir = ensureOpenSpecChange(root, 'rm')
    expect(archiveOpenSpecChange(root, 'rm')).toEqual({
      archivedTo: null,
      removed: true,
    })
    expect(fs.existsSync(dir)).toBe(false)
    const d2 = ensureOpenSpecChange(root, 'col')
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'archive'), {
      recursive: true,
    })
    fs.mkdirSync(
      path.join(root, 'openspec', 'changes', 'archive', '2026-10-20-col'),
    )
    const hit = archiveOpenSpecChange(root, 'col', {
      keepArchive: true,
      date: '2026-10-20',
    })
    expect(hit.archivedTo).toMatch(
      /^openspec\/changes\/archive\/2026-10-20-col-\d+$/,
    )
    expect(fs.existsSync(d2)).toBe(false)
  })

  it('loadOpenSpecConfig and rulesForArtifact edges', () => {
    const root = tmp()
    expect(loadOpenSpecConfig(root).schema).toBe('spec-driven')
    expect(() => loadOpenSpecConfig(path.join(root, 'missing'))).toThrow(
      /missing/,
    )
    fs.writeFileSync(path.join(root, 'openspec', 'config.yaml'), '[]\n')
    expect(() => loadOpenSpecConfig(root)).toThrow(/object/)
    expect(rulesForArtifact({}, 'proposal')).toEqual([])
    expect(rulesForArtifact({ rules: [] }, 'proposal')).toEqual([])
    expect(
      rulesForArtifact({ rules: { proposal: 'x' } }, 'proposal'),
    ).toBeNull()
    expect(
      rulesForArtifact({ rules: { proposal: ['a', 2] } }, 'proposal'),
    ).toEqual(['a', '2'])
    expect(rulesForArtifact({ rules: { design: ['d'] } }, 'proposal')).toEqual(
      [],
    )
  })
})
