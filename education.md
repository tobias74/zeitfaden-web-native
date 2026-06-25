# Education Notes

## Why Newest-First And Oldest-First Can Have Different Performance

Our normal catalog query index is currently a timestamp-first packed index:

- File: `time-geo.idx`
- Logical order: `(timestampSec, assetId)`
- Payload per record: timestamp, latitude, longitude, asset id, kind flags
- Runtime storage: the index is loaded into RAM as a resident `ArrayBuffer`

Because the index is sorted by timestamp, a timestamp-only query is the easy case.
For `oldest first`, we scan the resident buffer forward. For `newest first`, we
scan the same resident buffer backward. In the pure timestamp-only case, both
directions should inspect roughly the same number of records, usually just enough
to fill the requested result page.

The surprise comes from filters.

If the query also has a bounding box, kind filter, or `hasGeo` filter, the
timestamp index can still preserve timestamp order, but those extra conditions are
applied while scanning. The query stops only after enough matching records have
been found.

That means performance depends on where the matching records live in time.

Example:

- The requested map area contains mostly old points.
- `oldest first` starts near those old points and finds enough matches quickly.
- `newest first` starts at the newest end and may scan many non-matching records
  before it reaches the old matching area.

The reverse can also happen. If the matching records are mostly recent,
`newest first` can be much faster than `oldest first`.

So the index scan direction itself is not fundamentally expensive. What matters
is how soon that scan direction finds enough records that also pass the filters.

## What The Metrics Mean

When comparing `newest first` and `oldest first`, look at these metrics:

- `candidatesInspected`: how many index records were checked.
- `diskReadCount`: how many asset metadata reads happened.
- `diskReadBytes`: how much asset metadata was read.
- `queryTimeMs`: total query time.

If `candidatesInspected` is very different, the performance difference is caused
by data distribution and early stopping. One direction finds matching rows sooner
than the other.

If `candidatesInspected` is similar but `queryTimeMs` differs, the likely cause is
asset metadata reads, browser filesystem behavior, or cache locality rather than
the timestamp index scan itself.

## Practical Rule

Timestamp-first indexing is excellent when the UI always wants timestamp-ordered
results. It lets us retun already-sorted pages without a query-time sort.

But for broad bbox queries, the bbox is not the leading key. It is a filter after
the timestamp scan. That is why broad spatial filters can still be expensive,
especially when the requested sort direction starts far away from the matching
records in time.

This is not a bug in newest-first or oldest-first. It is the central tradeoff of
using a timestamp-first index: ordering by time is cheap, but spatial filtering is
only as cheap as the data distribution allows.
