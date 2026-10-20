import { describe, expect, it } from 'vitest'
import {
  findExcludeReasonGaps,
  findUnclassifiedProductionFiles,
  loadMutatePatterns,
  selectMutableChanges,
} from './mutation-scope.mjs'

const patterns = loadMutatePatterns()

describe('selectMutableChanges', () => {
  it('mutates processPhoto.ts and skips a test and the photo worker', () => {
    expect(
      selectMutableChanges(
        [
          'src/photo/processPhoto.ts',
          'src/photo/processPhoto.test.ts',
          'src/photo/photo.worker.ts',
        ],
        patterns,
      ),
    ).toEqual(['src/photo/processPhoto.ts'])
  })

  it.each([
    'src/perf/percentile.ts',
    'src/photo/jpegSof.ts',
    'src/photo/loadPhoto.ts',
    'src/editor/dropHover.ts',
    'src/editor/thumbSlotSize.ts',
    'src/render/SpreadView.tsx',
    'src/core/index.ts',
    'src/project/index.ts',
    'src/assets/index.ts',
  ])('mutates %s', (file) => {
    expect(selectMutableChanges([file], patterns)).toEqual([file])
  })

  it.each([
    'src/photo/photo.test-helpers.ts',
    'src/photo/fileSystemAccess.d.ts',
    'src/core/testing/fixtures.ts',
    'src/main.tsx',
    'src/core/ops/ops.bench.ts',
    'src/render/SpreadView.test.tsx',
  ])('does not mutate %s', (file) => {
    expect(selectMutableChanges([file], patterns)).toEqual([])
  })

  it.each(['src/core/index.ts', 'src/project/index.ts', 'src/assets/index.ts'])(
    'mutates barrel %s (re-export excludes removed)',
    (file) => {
      expect(selectMutableChanges([file], patterns)).toEqual([file])
    },
  )
})

describe('findUnclassifiedProductionFiles', () => {
  it('reports a production file that matches neither include nor exclude', () => {
    expect(
      findUnclassifiedProductionFiles(
        ['src/perf/percentile.ts'],
        ['src/photo/**/*.ts'],
      ),
    ).toEqual(['src/perf/percentile.ts'])
  })

  it('reports an unclassified script', () => {
    expect(
      findUnclassifiedProductionFiles(
        ['scripts/orphan.mjs'],
        ['src/**/*.ts', '!scripts/**/*.test.mjs'],
      ),
    ).toEqual(['scripts/orphan.mjs'])
  })
})

describe('scripts not in mutate scope', () => {
  it('scripts are unclassified after removal from mutate', () => {
    expect(selectMutableChanges(['scripts/agent.mjs'], patterns)).toEqual([])
    expect(selectMutableChanges(['scripts/agent-cli.mjs'], patterns)).toEqual(
      [],
    )
  })
})

describe('findExcludeReasonGaps', () => {
  it('reports an exclude that has no reason line', () => {
    expect(
      findExcludeReasonGaps(
        ['src/**/*.ts', '!src/main.tsx'],
        '- `!src/photo/photo.worker.ts` — wrapper\n',
      ),
    ).toEqual({
      missing: ['!src/main.tsx'],
      extra: ['!src/photo/photo.worker.ts'],
    })
  })
})
