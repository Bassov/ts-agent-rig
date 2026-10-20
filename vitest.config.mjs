import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkgRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: pkgRoot,
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/resolve-repo-root.ts',
        'src/gates/compare-pin.ts',
      ],
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 85,
        statements: 85,
      },
    },
  },
})
