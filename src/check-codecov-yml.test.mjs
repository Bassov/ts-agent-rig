import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CODECOV_YML_REL,
  PINNED_TOP_LEVEL_KEYS,
  checkCodecovYml,
  defaultCodecovRoot,
  findUnknownTopLevelKeys,
  isCodecovYmlModifiedVsBase,
  isNetworkError,
  runCodecovYmlCli,
  shouldValidateCodecovYmlRemote,
  validateCodecovYml,
  validateCodecovYmlLocal,
} from './check-codecov-yml.mjs'
import { stripGitKeys } from './strip-git-env.mjs'

const ROOT = resolveRepoRoot()
const mainYml = fs.readFileSync(path.join(ROOT, 'codecov.yml'), 'utf8')

describe('findUnknownTopLevelKeys', () => {
  it('flags root notify instead of codecov.notify', () => {
    const bad = 'notify:\n  after_n_builds: 2\ncoverage:\n  status: {}\n'
    expect(findUnknownTopLevelKeys(bad)).toContain('notify')
  })

  it('accepts main codecov.yml keys', () => {
    expect(findUnknownTopLevelKeys(mainYml)).toEqual([])
  })
})

describe('isNetworkError', () => {
  it('detects fetch TypeError', () => {
    const err = new TypeError('fetch failed')
    expect(isNetworkError(err)).toBe(true)
  })

  it('detects errno codes and nested cause', () => {
    expect(isNetworkError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(
      isNetworkError({ message: 'wrap', cause: new TypeError('fetch failed') }),
    ).toBe(true)
  })

  it('rejects ordinary errors and non-objects', () => {
    expect(isNetworkError(new Error('Valid! missing'))).toBe(false)
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError('fetch failed')).toBe(false)
  })
})

describe('findUnknownTopLevelKeys edge cases', () => {
  it('rejects non-object roots', () => {
    expect(findUnknownTopLevelKeys('[]')).toEqual(['<root-not-object>'])
    expect(findUnknownTopLevelKeys('null')).toEqual(['<root-not-object>'])
  })
})

describe('validateCodecovYmlLocal', () => {
  it('accepts main codecov.yml keys', () => {
    expect(validateCodecovYmlLocal(mainYml)).toEqual({
      ok: true,
      mode: 'local',
      detail: 'pinned top-level keys OK',
    })
  })

  it('rejects unknown top-level keys', () => {
    const bad = 'notify:\n  after_n_builds: 2\ncoverage:\n  status: {}\n'
    expect(validateCodecovYmlLocal(bad)).toEqual({
      ok: false,
      mode: 'local',
      detail: 'unknown top-level keys: notify',
    })
  })
})

describe('shouldValidateCodecovYmlRemote', () => {
  it('is true when CI, --remote, or codecov.yml modified', () => {
    expect(
      shouldValidateCodecovYmlRemote({
        env: { CI: 'true' },
        codecovYmlModified: false,
      }),
    ).toBe(true)
    expect(
      shouldValidateCodecovYmlRemote({
        forceRemote: true,
        env: {},
        codecovYmlModified: false,
      }),
    ).toBe(true)
    expect(
      shouldValidateCodecovYmlRemote({
        env: {},
        codecovYmlModified: true,
      }),
    ).toBe(true)
  })

  it('is false when unchanged and not CI', () => {
    expect(
      shouldValidateCodecovYmlRemote({
        env: {},
        codecovYmlModified: false,
      }),
    ).toBe(false)
  })
})

describe('isCodecovYmlModifiedVsBase', () => {
  it('treats missing base ref as modified', () => {
    expect(
      isCodecovYmlModifiedVsBase({
        runGit: () => ({ status: 1 }),
      }),
    ).toBe(true)
  })

  it('detects diff vs base ref', () => {
    const calls = []
    const runGit = (args) => {
      calls.push(args)
      if (args[0] === 'rev-parse') return { status: 0 }
      if (args[0] === 'diff') return { status: 1 }
      return { status: 1 }
    }
    expect(isCodecovYmlModifiedVsBase({ runGit })).toBe(true)
    expect(calls).toContainEqual([
      'diff',
      '--quiet',
      'origin/main',
      '--',
      CODECOV_YML_REL,
    ])
  })
})

describe('validateCodecovYml', () => {
  it('passes when API returns Valid!', async () => {
    const fetchImpl = async () =>
      /** @type {Response} */ ({
        status: 200,
        text: async () => 'Valid!\n\n{"coverage":{}}',
      })
    const r = await validateCodecovYml(mainYml, { fetchImpl })
    expect(r).toEqual({ ok: true, mode: 'api', detail: 'Valid!' })
  })

  it('fails on unknown top-level key via API rejection', async () => {
    const bad = 'notify:\n  after_n_builds: 2\n'
    const fetchImpl = async () =>
      /** @type {Response} */ ({
        status: 400,
        text: async () => 'Error: unknown field notify',
      })
    const r = await validateCodecovYml(bad, { fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('api')
  })

  it('network error uses pinned key fallback and fails unknown keys', async () => {
    const bad = 'notify:\n  after_n_builds: 2\ncoverage:\n  status: {}\n'
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    const r = await validateCodecovYml(bad, { fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('fallback')
    expect(r.detail).toMatch(/notify/)
  })

  it('network error accepts main file via fallback', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    const r = await validateCodecovYml(mainYml, { fetchImpl })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('fallback')
  })

  it('validation failure does not fall back', async () => {
    const fetchImpl = async () =>
      /** @type {Response} */ ({
        status: 400,
        text: async () => 'Invalid config',
      })
    const r = await validateCodecovYml(mainYml, { fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('api')
  })

  it('non-network throw stays api failure without fallback', async () => {
    const fetchImpl = async () => {
      throw new Error('boom')
    }
    const r = await validateCodecovYml(mainYml, { fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('api')
    expect(r.detail).toMatch(/boom/)
  })

  it('rejects when first line is not exactly Valid!', async () => {
    const fetchImpl = async () =>
      /** @type {Response} */ ({
        status: 200,
        text: async () => 'Almost Valid!\n',
      })
    const r = await validateCodecovYml(mainYml, { fetchImpl })
    expect(r.ok).toBe(false)
  })
})

describe('checkCodecovYml against repo file', () => {
  it('main codecov.yml passes locally without remote when unchanged', async () => {
    const fetchImpl = async () => {
      throw new Error('fetch should not run')
    }
    const r = await checkCodecovYml({
      root: ROOT,
      env: {},
      codecovYmlModified: false,
      fetchImpl,
    })
    expect(r).toEqual({
      ok: true,
      mode: 'local',
      detail: 'pinned top-level keys OK',
    })
  })

  it('main codecov.yml uses remote when forced', async () => {
    const r = await checkCodecovYml({
      root: ROOT,
      forceRemote: true,
      fetchImpl: async () =>
        /** @type {Response} */ ({
          status: 200,
          text: async () => 'Valid!',
        }),
    })
    expect(r).toEqual({ ok: true, mode: 'api', detail: 'Valid!' })
  })

  it('missing file fails', async () => {
    const r = await checkCodecovYml({
      root: ROOT,
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/missing|ENOENT/)
  })

  it('uses injected fetchImpl when remote validation runs', async () => {
    const r = await checkCodecovYml({
      root: ROOT,
      forceRemote: true,
      fetchImpl: async () =>
        /** @type {Response} */ ({
          status: 200,
          text: async () => 'Valid!',
        }),
    })
    expect(r).toEqual({ ok: true, mode: 'api', detail: 'Valid!' })
  })

  it('fails locally on unknown keys without remote', async () => {
    const bad = 'notify:\n  after_n_builds: 2\ncoverage:\n  status: {}\n'
    const r = await checkCodecovYml({
      root: ROOT,
      readFile: () => bad,
      env: {},
      codecovYmlModified: false,
      fetchImpl: async () => {
        throw new Error('fetch should not run')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('local')
  })
})

describe('runCodecovYmlCli', () => {
  it('logs OK (local) and returns 0 when remote skipped', async () => {
    const lines = []
    const code = await runCodecovYmlCli({
      root: ROOT,
      env: {},
      codecovYmlModified: false,
      fetchImpl: async () => {
        throw new Error('fetch should not run')
      },
      log: (m) => lines.push(m),
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/OK \(local\)/)
  })

  it('logs OK (api) and returns 0 with --remote', async () => {
    const lines = []
    const code = await runCodecovYmlCli({
      root: ROOT,
      argv: ['node', 'cli', '--remote'],
      fetchImpl: async () =>
        /** @type {Response} */ ({
          status: 200,
          text: async () => 'Valid!',
        }),
      log: (m) => lines.push(m),
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/OK \(api\)/)
  })

  it('logs FAIL and returns 1', async () => {
    const lines = []
    const code = await runCodecovYmlCli({
      root: ROOT,
      readFile: () => {
        throw new Error('gone')
      },
      error: (m) => lines.push(m),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/FAIL/)
  })
})

describe('codecov-yml-cli entry', () => {
  it('exits 0 for the repo codecov.yml without CI remote', () => {
    const r = spawnSync(process.execPath, ['packages/ts-agent-rig/src/codecov-yml-cli.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: stripGitKeys({ ...process.env, CI: '' }),
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Codecov YAML: OK \(local\)/)
  })
})

describe('isNetworkError conditionals', () => {
  it('requires TypeError name with network-ish message', () => {
    expect(isNetworkError({ name: 'TypeError', message: 'fetch failed' })).toBe(
      true,
    )
    expect(isNetworkError({ name: 'TypeError', message: 'other' })).toBe(false)
    expect(isNetworkError({ name: 'Error', message: 'fetch failed' })).toBe(
      false,
    )
  })

  it('requires string code matching network errno pattern', () => {
    expect(isNetworkError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isNetworkError({ code: 123 })).toBe(false)
    expect(isNetworkError({ code: 'ENOENT' })).toBe(false)
  })

  it('walks cause only when present', () => {
    expect(isNetworkError({ message: 'x', cause: null })).toBe(false)
    expect(
      isNetworkError({
        message: 'x',
        cause: { name: 'TypeError', message: 'network down' },
      }),
    ).toBe(true)
  })
})

describe('checkCodecovYml defaults and exact details', () => {
  it('defaultCodecovRoot points at the repo root containing codecov.yml', () => {
    expect(defaultCodecovRoot()).toBe(ROOT)
    expect(PINNED_TOP_LEVEL_KEYS).toContain('coverage')
    expect(CODECOV_YML_REL).toBe('codecov.yml')
  })

  it('uses default root when root is omitted', async () => {
    const r = await checkCodecovYml({
      forceRemote: true,
      fetchImpl: async (_url, init) => {
        expect(String(init && init.body)).toContain('coverage:')
        return /** @type {Response} */ ({
          status: 200,
          text: async () => 'Valid!',
        })
      },
    })
    expect(r).toEqual({ ok: true, mode: 'api', detail: 'Valid!' })
  })

  it('forwards validateUrl and asserts rejection detail format', async () => {
    const seen = []
    const longBody = 'x'.repeat(600)
    const r = await validateCodecovYml(mainYml, {
      validateUrl: 'https://example.test/validate',
      fetchImpl: async (url, init) => {
        seen.push({
          url,
          method: init && init.method,
          headers: init && init.headers,
        })
        return /** @type {Response} */ ({
          status: 418,
          text: async () => longBody,
        })
      },
    })
    expect(seen).toEqual([
      {
        url: 'https://example.test/validate',
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      },
    ])
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('api')
    expect(r.detail).toBe(
      `Codecov validator rejected (HTTP 418): ${'x'.repeat(500)}`,
    )
  })

  it('fallback detail strings are exact', async () => {
    const bad = await validateCodecovYml('notify:\n  after_n_builds: 1\n', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect(bad).toEqual({
      ok: false,
      mode: 'fallback',
      detail: 'network error; unknown top-level keys: notify',
    })
    const ok = await validateCodecovYml(mainYml, {
      fetchImpl: async () => {
        throw { code: 'ECONNRESET' }
      },
    })
    expect(ok).toEqual({
      ok: true,
      mode: 'fallback',
      detail: 'network error; pinned top-level keys OK',
    })
  })

  it('missing file detail names codecov.yml exactly', async () => {
    const r = await checkCodecovYml({
      root: ROOT,
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(r).toEqual({
      ok: false,
      mode: 'api',
      detail: 'missing codecov.yml: ENOENT',
    })
  })
})
