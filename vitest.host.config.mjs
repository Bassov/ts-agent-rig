import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkgRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: pkgRoot,
  test: {
    include: ['src/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
