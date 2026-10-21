import { describe, expect, it } from 'vitest'
import {
  checkPrBody,
  extractMarkdownHeadings,
  findFixReviseVerdicts,
  isSectionNonEmpty,
  sectionBody,
  stripHtmlComments,
} from './check-pr-body.mjs'

const template = `## Summary

-

## OpenSpec

- Change:

## Manual test scenarios

1.

## Metrics

-
`

describe('check-pr-body', () => {
  it('extracts headings and section bodies', () => {
    expect(extractMarkdownHeadings(template)).toEqual([
      'Summary',
      'OpenSpec',
      'Manual test scenarios',
      'Metrics',
    ])
    expect(isSectionNonEmpty(sectionBody(template, 'Summary'))).toBe(false)
    expect(
      isSectionNonEmpty(
        sectionBody('## Summary\n\n- shipped patch coverage\n', 'Summary'),
      ),
    ).toBe(true)
  })

  it('strips nested HTML comment wrappers until no <!-- remains', () => {
    expect(stripHtmlComments('<!-- only -->')).toBe('')
    expect(stripHtmlComments('<!<!---->-->')).not.toContain('<!--')
    expect(stripHtmlComments('<!<!--- comment -->>')).not.toContain('<!--')
    expect(isSectionNonEmpty('<!-- placeholder -->\n-\n')).toBe(false)
    expect(isSectionNonEmpty('<!-- only -->\n')).toBe(false)
  })

  it('treats bare N/A as a filled section (e.g. Metrics when not applicable)', () => {
    expect(isSectionNonEmpty('N/A\n')).toBe(true)
    expect(isSectionNonEmpty('n/a\n')).toBe(true)
    expect(isSectionNonEmpty('-\n')).toBe(false)
    const naMetrics = `## Summary

- docs cleanup

## OpenSpec

- Change: N/A

## Manual test scenarios

1. N/A (non-UI)

## Metrics

N/A
`
    expect(checkPrBody({ body: naMetrics, templateText: template }).ok).toBe(
      true,
    )
  })

  it('requires non-empty template sections and rejects fix/revise', () => {
    const good = `## Summary

- local patch coverage

## OpenSpec

- Change: N/A
- Archived: N/A
- Docs/rules updated: yes

## Manual test scenarios

1. N/A (prep / no UI)

## Metrics

- wall_time_sec: 12
`
    expect(checkPrBody({ body: good, templateText: template }).ok).toBe(true)

    const missing = checkPrBody({
      body: '## Summary\n\n- x\n',
      templateText: template,
    })
    expect(missing.ok).toBe(false)
    expect(missing.problems.some((p) => /OpenSpec/.test(p))).toBe(true)

    expect(findFixReviseVerdicts('Verdict: fix — gates')).toEqual([
      'Verdict: fix — gates',
    ])
    expect(
      findFixReviseVerdicts(
        '- Trim spread-view; fix stale wording on project-session-mutation.',
      ),
    ).toEqual([])
    const badVerdict = checkPrBody({
      body: `${good}\n\n## Reviewer verdicts\n\n- Verdict: revise\n`,
      templateText: template,
    })
    expect(badVerdict.ok).toBe(false)
  })
})
