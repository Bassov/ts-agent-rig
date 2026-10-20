import { describe, expect, it } from 'vitest'
import {
  MANUAL_QA_CPU_THROTTLE,
  parseManualScenarios,
} from './manual-qa-scenarios.mjs'

describe('manual-qa', () => {
  it('pins 4x CPU throttle and parses scenario lines', () => {
    expect(MANUAL_QA_CPU_THROTTLE).toBe(4)
    const scenarios = parseManualScenarios(`
**Browser check:** editor shows Photobooks
**Perf:** filmstrip scroll 0 LoAF

## Manual test scenarios

1. open home and start session
2. zoom pasteboard

## Other
`)
    expect(scenarios).toEqual([
      'editor shows Photobooks',
      'perf: filmstrip scroll 0 LoAF',
      'open home and start session',
      'zoom pasteboard',
    ])
  })
})
