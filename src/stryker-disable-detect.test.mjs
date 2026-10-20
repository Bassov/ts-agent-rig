import { describe, expect, it } from 'vitest'
import {
  DISABLE_KEYWORD,
  NEXT_LINE_KEYWORD,
  RESTORE_KEYWORD,
  STRYKER_DISABLE_PER_FILE_CAP,
  STRYKER_DISABLE_REASON_MIN,
  STRYKER_KEYWORD,
  classifyStrykerDisableLine,
  collectStrykerDisableComments,
  countStrykerDisable,
  countStrykerDisableMainStyle,
  findNextStrykerDirective,
  indexOfIgnoreCase,
  isIdentContinue,
  isStrykerDetectorPath,
  isWsChar,
  lineContaining,
  matchKeywordAt,
  matchPrefixIgnoreCase,
  skipWs,
  tryParseLegalNextLineDisable,
} from './stryker-disable-detect.mjs'

const LEGAL = '// Stryker disable next-line BooleanLiteral: justified reason ok'

describe('stryker-disable-detect', () => {
  it('pins constants', () => {
    expect(STRYKER_DISABLE_PER_FILE_CAP).toBe(3)
    expect(STRYKER_DISABLE_REASON_MIN).toBe(10)
    expect(STRYKER_KEYWORD).toBe('stryker')
    expect(DISABLE_KEYWORD).toBe('disable')
    expect(RESTORE_KEYWORD).toBe('restore')
    expect(NEXT_LINE_KEYWORD).toBe('next-line')
  })

  it('isWsChar and isIdentContinue', () => {
    expect(isWsChar(' ')).toBe(true)
    expect(isWsChar('\t')).toBe(true)
    expect(isWsChar('\n')).toBe(true)
    expect(isWsChar('\r')).toBe(true)
    expect(isWsChar('\f')).toBe(true)
    expect(isWsChar('a')).toBe(false)
    expect(isWsChar('')).toBe(false)
    expect(isIdentContinue('a')).toBe(true)
    expect(isIdentContinue('Z')).toBe(true)
    expect(isIdentContinue('0')).toBe(true)
    expect(isIdentContinue('9')).toBe(true)
    expect(isIdentContinue('_')).toBe(true)
    expect(isIdentContinue('$')).toBe(true)
    expect(isIdentContinue('-')).toBe(false)
    expect(isIdentContinue('/')).toBe(false)
    expect(isIdentContinue('@')).toBe(false)
    expect(isIdentContinue(' ')).toBe(false)
  })

  it('indexOfIgnoreCase / skipWs / match helpers', () => {
    expect(indexOfIgnoreCase('xx STRYKER yy', 'stryker', 0)).toBe(3)
    expect(indexOfIgnoreCase('abc', 'stryker', 0)).toBe(-1)
    expect(indexOfIgnoreCase('stryker', 'stryker', -2)).toBe(0)
    expect(skipWs('  ab', 0)).toBe(2)
    expect(skipWs('ab', 0)).toBe(0)
    expect(matchPrefixIgnoreCase('DISABLE', 0, 'disable')).toBe(7)
    expect(matchPrefixIgnoreCase('xdisable', 0, 'disable')).toBe(-1)
    expect(matchKeywordAt('stryker ', 0, 'stryker')).toBe(7)
    expect(matchKeywordAt('strykerDisable', 0, 'stryker')).toBe(-1)
  })

  it('main-style count and never-fewer', () => {
    expect(countStrykerDisableMainStyle('Strykerdisable')).toBe(1)
    expect(countStrykerDisableMainStyle('stryker disable')).toBe(0)
    expect(countStrykerDisableMainStyle('Stryker  disable x')).toBe(1)
    expect(countStrykerDisableMainStyle('Stryker\tdisable x')).toBe(1)
    expect(countStrykerDisableMainStyle('Strykerenable')).toBe(0)
    const samples = [
      '',
      LEGAL,
      '/* Stryker disable all */',
      'const x = 1 // Stryker disable all',
      'Strykerdisable',
      'stryker disable all',
      '// Stryker restore all',
    ]
    for (const s of samples) {
      expect(countStrykerDisable(s)).toBeGreaterThanOrEqual(
        countStrykerDisableMainStyle(s),
      )
    }
  })

  it('findNextStrykerDirective shapes', () => {
    expect(findNextStrykerDirective('Strykerdisable', 0)).toEqual({
      at: 0,
      verb: 'disable',
      verbEnd: 'Strykerdisable'.length,
    })
    expect(findNextStrykerDirective('strykerdisable', 0)).toBeNull()
    expect(findNextStrykerDirective('Strykerfoo', 0)).toBeNull()
    expect(findNextStrykerDirective('nope', 0)).toBeNull()
    expect(findNextStrykerDirective('stryker restore all', 0)).toEqual({
      at: 0,
      verb: 'restore',
      verbEnd: 'stryker restore'.length,
    })
    expect(findNextStrykerDirective('  stryker   disable all', 0)).toEqual({
      at: 2,
      verb: 'disable',
      verbEnd: '  stryker   disable'.length,
    })
  })

  it('tryParseLegalNextLineDisable and lineContaining', () => {
    const at = LEGAL.indexOf('Stryker')
    const verbEnd = LEGAL.indexOf('disable') + 'disable'.length
    expect(tryParseLegalNextLineDisable(LEGAL, { at, verbEnd })).toEqual({
      reason: 'justified reason ok',
      mutators: 'BooleanLiteral',
    })
    expect(
      tryParseLegalNextLineDisable('const x = 1 // Stryker disable all', {
        at: 'const x = 1 // '.length,
        verbEnd: 'const x = 1 // Stryker disable'.length,
      }),
    ).toBeNull()
    expect(
      tryParseLegalNextLineDisable(
        '// Stryker disable next-line BooleanLiteral: short',
        {
          at: 3,
          verbEnd: 3 + 'Stryker disable'.length,
        },
      ),
    ).toBeNull()
    expect(lineContaining('a\nbStryker\nc', 3)).toBe('bStryker')
  })

  it('collect / classify / probes', () => {
    expect(classifyStrykerDisableLine(LEGAL)).toEqual({
      kind: 'legal',
      reason: 'justified reason ok',
      mutators: 'BooleanLiteral',
    })
    expect(classifyStrykerDisableLine('// Stryker disable all')).toEqual({
      kind: 'illegal',
    })
    expect(classifyStrykerDisableLine('export const x = 1')).toBeNull()
    expect(collectStrykerDisableComments(LEGAL)).toEqual({
      legal: [
        {
          reason: 'justified reason ok',
          mutators: 'BooleanLiteral',
          line: LEGAL,
        },
      ],
      illegal: [],
    })
    expect(collectStrykerDisableComments('/* Stryker disable all */')).toEqual({
      legal: [],
      illegal: [{ line: '/* Stryker disable all */' }],
    })
    expect(
      collectStrykerDisableComments('const x = 1 // Stryker disable all'),
    ).toEqual({
      legal: [],
      illegal: [{ line: 'const x = 1 // Stryker disable all' }],
    })
    expect(
      collectStrykerDisableComments(
        '  /* Stryker disable next-line all */ foo()',
      ).illegal.length,
    ).toBe(1)
    expect(collectStrykerDisableComments('// Stryker restore all')).toEqual({
      legal: [],
      illegal: [{ line: '// Stryker restore all' }],
    })
    expect(countStrykerDisable(LEGAL)).toBe(1)
    expect(
      countStrykerDisable('// Stryker disable all\n// Stryker restore all\n'),
    ).toBe(2)
  })

  it('isStrykerDetectorPath', () => {
    expect(isStrykerDetectorPath('scripts/stryker-disable-detect.mjs')).toBe(
      true,
    )
    expect(isStrykerDetectorPath('scripts/check-gate-ratchet.mjs')).toBe(true)
    expect(isStrykerDetectorPath('scripts/stryker-pr-summary.mjs')).toBe(false)
  })
})
