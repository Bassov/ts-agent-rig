import { existsSync } from 'node:fs'
import path from 'node:path'
import { chdir } from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkgRoot = path.dirname(fileURLToPath(import.meta.url))
const monorepoRoot = path.resolve(pkgRoot, '../..')
/** In-repo: run with host cwd so gates/roadmap/stryker configs resolve. */
const hostRoot = existsSync(path.join(monorepoRoot, 'quality', 'gates.json'))
  ? monorepoRoot
  : pkgRoot
if (process.cwd() !== hostRoot) chdir(hostRoot)

const srcGlob = path.relative(hostRoot, path.join(pkgRoot, 'src'))

export default defineConfig({
  test: {
    include: [
      `${srcGlob.replaceAll('\\', '/')}/**/*.test.mjs`,
      'packages/ts-agent-rig/test/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: [`${srcGlob.replaceAll('\\', '/')}/**/*.mjs`],
      exclude: [
        `${srcGlob.replaceAll('\\', '/')}/**/*.test.mjs`,
        `${srcGlob.replaceAll('\\', '/')}/**/*-cli.mjs`,
        `${srcGlob.replaceAll('\\', '/')}/**/fixtures/**`,
      ],
      thresholds: {
        lines: 70,
        branches: 60,
        functions: 70,
        statements: 70,
      },
    },
  },
})
