import { describe, expect, it } from 'vitest'
import { extractSqliteUsedIndexes } from './sqlExplain'

describe('extractSqliteUsedIndexes', () => {
  it('extracts normal and covering index names from SQLite explain rows', () => {
    expect(
      extractSqliteUsedIndexes([
        'SEARCH a USING COVERING INDEX idx_assets_kind_timestamp_hash (kind=?)',
        'SEARCH l USING INDEX idx_locations_content_hash (content_hash=?)',
        'SCAN media_assets',
      ]),
    ).toEqual(['idx_assets_kind_timestamp_hash', 'idx_locations_content_hash'])
  })

  it('returns an empty list when SQLite scans without an index', () => {
    expect(extractSqliteUsedIndexes(['SCAN media_assets'])).toEqual([])
  })
})
