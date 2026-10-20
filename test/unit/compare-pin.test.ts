import { describe, expect, it } from 'vitest'
import {
  extractPnpmLockPackageBlock,
  readPackageDepSpec,
} from '../../src/gates/compare-pin.ts'

describe('readPackageDepSpec', () => {
  it('reads from dependencies and devDependencies', () => {
    expect(readPackageDepSpec({ dependencies: { a: '1' } }, 'a')).toBe('1')
    expect(
      readPackageDepSpec({ devDependencies: { '@albasov/ts-agent-rig': 'workspace:*' } }, '@albasov/ts-agent-rig'),
    ).toBe('workspace:*')
    expect(readPackageDepSpec({}, 'x')).toBeNull()
  })
})

describe('extractPnpmLockPackageBlock', () => {
  it('captures matching lock lines', () => {
    const lock = `packages:\n  '@albasov/ts-agent-rig@0.1.0':\n    resolution: {integrity: sha}\n`
    expect(extractPnpmLockPackageBlock(lock, '@albasov/ts-agent-rig')).toContain(
      'resolution',
    )
    expect(extractPnpmLockPackageBlock('', 'x')).toBe('')
  })
})
