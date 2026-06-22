import { describe, expect, it } from 'vitest'
import { S2_CELL_INDEX_LEVEL, s2CellIdHexForLatLon } from './s2Cells'

describe('S2 cell helpers', () => {
  it('creates fixed-width level 15 cell ids', () => {
    expect(S2_CELL_INDEX_LEVEL).toBe(15)
    expect(s2CellIdHexForLatLon(48.1370673, 11.5775995)).toBe(
      '479e758b40000000',
    )
  })

  it('keeps nearby points in deterministic cells', () => {
    expect(s2CellIdHexForLatLon(47.3769, 8.5417)).toMatch(/^[0-9a-f]{16}$/)
    expect(s2CellIdHexForLatLon(40.7128, -74.006)).toMatch(/^[0-9a-f]{16}$/)
  })
})
