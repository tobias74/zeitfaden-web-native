import { describe, expect, it } from 'vitest'
import { haversineMeters } from './distance'

describe('haversineMeters', () => {
  it('returns zero for identical points', () => {
    expect(haversineMeters(47.3769, 8.5417, 47.3769, 8.5417)).toBeCloseTo(0)
  })

  it('handles points across the antimeridian', () => {
    const distance = haversineMeters(0, 179.9, 0, -179.9)
    expect(distance).toBeLessThan(25_000)
  })

  it('handles polar-near points', () => {
    const distance = haversineMeters(89.9, 0, 89.9, 90)
    expect(distance).toBeGreaterThan(0)
    expect(distance).toBeLessThan(20_000)
  })
})

