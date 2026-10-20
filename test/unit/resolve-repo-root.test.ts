import { describe, expect, it } from 'vitest'
import { resolveRepoRoot } from '../../src/resolve-repo-root.ts'

describe('resolveRepoRoot', () => {
  it('prefers TS_RIG_REPO_ROOT', () => {
    expect(
      resolveRepoRoot({
        cwd: '/tmp/nowhere',
        env: { TS_RIG_REPO_ROOT: '/custom/root' },
      }),
    ).toBe('/custom/root')
  })

  it('falls back to cwd when no gates and no git', () => {
    expect(
      resolveRepoRoot({
        cwd: '/tmp/ts-rig-no-gates-xyz',
        env: {},
      }),
    ).toBe('/tmp/ts-rig-no-gates-xyz')
  })
})
