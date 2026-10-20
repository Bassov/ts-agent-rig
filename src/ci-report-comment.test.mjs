import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import {
  classifySection,
  decodeState,
  emptyState,
  isLegacyStickyComment,
  isLighthouseReportFile,
  metricRows,
  normalizeState,
  renderComment,
  shouldWrite,
  upsertSection,
} from './ci-report-comment.mjs'

const passed = {
  reportPresent: true,
  stepOutcome: 'success',
  missingReport: 'job-failed',
  body: '## Coverage\n\n| Lines | 90% |',
}

describe('classifySection', () => {
  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
  ])(
    'treats a present report and step %s as check %s',
    (stepOutcome, check) => {
      expect(classifySection({ ...passed, stepOutcome })).toMatchObject({
        kind: 'job-succeeded',
        check,
      })
    },
  )

  it('skips a successful mutation run with no report', () => {
    expect(
      classifySection({
        reportPresent: false,
        stepOutcome: 'success',
        missingReport: 'skipped',
      }),
    ).toEqual({
      kind: 'skipped',
      reason: 'No changed files to mutate.',
    })
  })

  it.each(['failure', 'skipped'])(
    'fails the job when the step is %s and no report exists',
    (stepOutcome) => {
      expect(
        classifySection({
          reportPresent: false,
          stepOutcome,
          missingReport: 'job-failed',
        }),
      ).toEqual({
        kind: 'job-failed',
        reason: 'Job finished before a report was produced.',
      })
    },
  )

  it('fails lighthouse or coverage when the step succeeds without a report', () => {
    expect(
      classifySection({
        reportPresent: false,
        stepOutcome: 'success',
        missingReport: 'job-failed',
      }).kind,
    ).toBe('job-failed')
  })
})

describe('normalizeState', () => {
  it('adds waiting e2e when decoding a legacy three-section marker', () => {
    const legacy = {
      version: 1,
      headSha: 'sha',
      sections: {
        lighthouse: { kind: 'waiting' },
        mutation: { kind: 'waiting' },
        coverage: classifySection(passed),
      },
    }
    const normalized = normalizeState(legacy)
    expect(normalized.sections.e2e).toEqual({ kind: 'waiting' })
    expect(normalized.sections.coverage).toEqual(legacy.sections.coverage)
    expect(() => renderComment(legacy)).not.toThrow()
    expect(renderComment(legacy)).toContain('### ⏳ E2E\n\n**Waiting**')
  })

  it('returns emptyState for non-object state', () => {
    expect(normalizeState(null, 'abc')).toEqual(emptyState('abc'))
    expect(normalizeState(undefined, 'abc')).toEqual(emptyState('abc'))
    expect(normalizeState('nope', 'abc')).toEqual(emptyState('abc'))
  })

  it('fills missing headSha from the fallback argument', () => {
    const normalized = normalizeState({ sections: {} }, 'fallback-sha')
    expect(normalized.headSha).toBe('fallback-sha')
  })

  it('keeps version when present and defaults when missing', () => {
    expect(normalizeState({ headSha: 'a', version: 2 }).version).toBe(2)
    expect(normalizeState({ headSha: 'a' }).version).toBe(1)
  })

  it('ignores unknown extra sections', () => {
    const normalized = normalizeState({
      headSha: 'a',
      sections: {
        coverage: classifySection(passed),
        weird: { kind: 'waiting' },
      },
    })
    expect(normalized.sections.coverage).toEqual(classifySection(passed))
    expect(normalized.sections).not.toHaveProperty('weird')
    expect(normalized.sections.e2e).toEqual({ kind: 'waiting' })
  })
})

describe('upsertSection', () => {
  it('keeps neighboring sections and leaves the rest waiting', () => {
    const lighthouse = classifySection(passed)
    const coverage = classifySection({
      ...passed,
      stepOutcome: 'failure',
      body: 'totals',
    })

    const withLighthouse = upsertSection(null, 'lighthouse', lighthouse, 'sha')
    const withCoverage = upsertSection(
      withLighthouse,
      'coverage',
      coverage,
      'sha',
    )

    expect(withCoverage.sections.lighthouse).toEqual(lighthouse)
    expect(withCoverage.sections.coverage).toEqual(coverage)
    expect(withCoverage.sections.mutation).toEqual({ kind: 'waiting' })
    expect(withCoverage.sections.e2e).toEqual({ kind: 'waiting' })
  })

  it('resets other sections when the head SHA changes', () => {
    const lighthouse = classifySection(passed)
    const previous = upsertSection(null, 'lighthouse', lighthouse, 'old')
    const next = upsertSection(
      previous,
      'coverage',
      classifySection({ ...passed, body: 'next' }),
      'new',
    )

    expect(next.headSha).toBe('new')
    expect(next.sections.lighthouse).toEqual({ kind: 'waiting' })
    expect(next.sections.coverage.body).toBe('next')
  })
})

describe('renderComment', () => {
  it('shows status without a details block until the job succeeds', () => {
    const state = upsertSection(
      upsertSection(
        null,
        'mutation',
        classifySection({
          reportPresent: false,
          stepOutcome: 'success',
          missingReport: 'skipped',
        }),
        'sha',
      ),
      'coverage',
      classifySection({
        reportPresent: false,
        stepOutcome: 'failure',
        missingReport: 'job-failed',
      }),
      'sha',
    )
    const rendered = renderComment(state)

    expect(rendered).toContain('### ⏳ Lighthouse\n\n**Waiting**')
    expect(rendered).toContain(
      '### ⏭️ Mutation testing\n\n**Skipped** — No changed files to mutate.',
    )
    expect(rendered).toContain(
      '### ❌ Coverage\n\n**Job failed** — Job finished before a report was produced.',
    )
    expect(rendered).toContain('### ⏳ E2E\n\n**Waiting**')
    expect(rendered).not.toContain('<details>')
    expect(rendered).not.toContain('| Check |')
    expect(rendered).not.toContain('](#')
  })

  it('wraps a successful report once and keeps that wrapper on rewrite', () => {
    const state = upsertSection(
      null,
      'lighthouse',
      classifySection(passed),
      'sha',
    )
    const once = renderComment(state)
    const twice = renderComment(decodeState(once))

    expect(twice).toBe(once)
    expect(once.match(/<details>/g)).toHaveLength(1)
    expect(once).toContain('### ✅ Lighthouse')
    expect(once).toContain('**Job succeeded · Check passed**')
    expect(once).toContain('| **90%** |')
    expect(once.indexOf('| **90%** |')).toBeLessThan(once.indexOf('<details>'))
    expect(once).toContain(passed.body)
  })

  it('shows a failed check and lays metric columns in one row', () => {
    const body = [
      '## Lighthouse CI',
      '',
      '| Category | Score |',
      '| --- | --- |',
      '| Performance | 99 (median) |',
      '| Accessibility | 95 |',
      '| Budgets | **passed** |',
    ].join('\n')
    const rendered = renderComment(
      upsertSection(
        null,
        'lighthouse',
        classifySection({ ...passed, stepOutcome: 'failure', body }),
        'sha',
      ),
    )

    expect(rendered).toContain('### ⚠️ Lighthouse')
    expect(rendered).toContain('**Job succeeded · Check failed**')
    expect(rendered).toContain(
      '| Performance | Accessibility | Budgets |\n| :---: | :---: | :---: |\n| **99** | **95** | **passed** |',
    )
    expect(metricRows(body)).toEqual([
      { label: 'Performance', value: '99 (median)' },
      { label: 'Accessibility', value: '95' },
      { label: 'Budgets', value: 'passed' },
    ])
  })
})

describe('shouldWrite', () => {
  it('writes only for the live pull request head', () => {
    expect(shouldWrite('abc', 'abc')).toBe(true)
    expect(shouldWrite('abc', 'def')).toBe(false)
    expect(shouldWrite('', 'abc')).toBe(false)
  })
})

describe('isLighthouseReportFile', () => {
  it.each([
    ['lhr-1.json', true],
    ['lhr-.json', true],
    ['links.json', false],
    ['lhr-1.JSON', false],
    ['xlhr-1.json', false],
  ])('treats %s as a lighthouse report: %s', (name, expected) => {
    expect(isLighthouseReportFile(name)).toBe(expected)
  })
})

describe('isLegacyStickyComment', () => {
  it('matches the three replaced sticky headers only', () => {
    expect(
      isLegacyStickyComment(
        '<!-- Sticky Pull Request Commentlighthouse-ci -->\n## Lighthouse',
      ),
    ).toBe(true)
    expect(isLegacyStickyComment('## Deploying Preview to Cloudflare')).toBe(
      false,
    )
  })
})

test.prop([fc.string({ maxLength: 200 })])(
  'round-trips summary markdown that contains comment closers',
  (body) => {
    const markup = `${body} -->`
    const state = upsertSection(
      null,
      'mutation',
      classifySection({ ...passed, body: markup }),
      'sha',
    )
    const decoded = decodeState(renderComment(state))

    expect(decoded.sections.mutation.body).toBe(markup)
    expect(decoded.sections.lighthouse).toEqual({ kind: 'waiting' })
    expect(decoded.sections.coverage).toEqual({ kind: 'waiting' })
  },
)
