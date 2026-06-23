# Research Notes

## Segmented KD-tree Distance Index

The segmented KD-tree distance index was removed after testing against the
3 million geopoint dataset. Its query performance was very poor at that scale,
making it unsuitable as a supported distance index for the application.

Use the remaining disk-backed segmented ball-tree index, or the SQLite S2
cell B-tree where SQLite storage is available, for large geopoint imports.
