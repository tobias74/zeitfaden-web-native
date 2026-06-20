import { describe, expect, it } from 'vitest'
import { dateInputEndToMillis, dateInputToMillis } from './time'

describe('time input parsing', () => {
  it('keeps date-only inputs as whole-day ranges', () => {
    expect(dateInputToMillis('2026-06-20')).toBe(
      new Date('2026-06-20T00:00:00').getTime(),
    )
    expect(dateInputEndToMillis('2026-06-20')).toBe(
      new Date('2026-06-20T23:59:59.999').getTime(),
    )
  })

  it('uses exact local times from datetime-local inputs', () => {
    expect(dateInputToMillis('2026-06-20T14:30')).toBe(
      new Date('2026-06-20T14:30').getTime(),
    )
    expect(dateInputEndToMillis('2026-06-20T18:45')).toBe(
      new Date('2026-06-20T18:45').getTime(),
    )
  })
})
