use chrono::{DateTime, NaiveDateTime};
use exif::{In, Reader as ExifReader, Tag, Value as ExifValue};
use image::ImageFormat;
use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader as XmlReader;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Window};
use walkdir::WalkDir;

type AppResult<T> = Result<T, String>;

const IMPORT_BATCH_SIZE: usize = 1000;
const SQLITE_BIND_CHUNK_LIMIT: usize = 12000;
const ASSET_BIND_COLUMNS: usize = 15;
const LOCATION_BIND_COLUMNS: usize = 8;
const GEO_IMPORT_PREFIX_BYTES: usize = 512 * 1024;
const PROGRESS_HEARTBEAT_MS: u128 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogInfo {
    storage_mode: String,
    sqlite_version: String,
    filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaSource {
    id: String,
    label: String,
    added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaLocation {
    id: String,
    source_id: String,
    relative_path: Option<String>,
    absolute_path: Option<String>,
    display_name: String,
    deleted_at: Option<i64>,
    last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaItem {
    id: String,
    content_hash: String,
    source_id: String,
    relative_path: String,
    display_name: String,
    kind: String,
    mime_type: String,
    size_bytes: i64,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    captured_at: Option<i64>,
    captured_at_source: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    geo_source: Option<String>,
    thumbnail_key: Option<String>,
    deleted_at: Option<i64>,
    last_seen_at: i64,
    locations: Vec<MediaLocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoBounds {
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogQuery {
    kind: Option<String>,
    source_id: Option<String>,
    has_geo: Option<bool>,
    geo_bounds: Option<GeoBounds>,
    sort: String,
    limit: Option<i64>,
    offset: Option<i64>,
    start_time: Option<i64>,
    end_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeRange {
    start_time: Option<i64>,
    end_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoIndexPoint {
    media_id: String,
    kind: Option<String>,
    lat: f64,
    lon: f64,
    captured_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoSearchQuery {
    lat: f64,
    lon: f64,
    k: i64,
    offset: Option<i64>,
    kind: Option<String>,
    geo_bounds: Option<GeoBounds>,
    start_time: Option<i64>,
    end_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GeoSearchResult {
    media_id: String,
    distance_meters: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoIndexStats {
    engine_id: String,
    point_count: usize,
    index_size_bytes: Option<usize>,
    build_time_ms: Option<f64>,
    insert_time_ms: Option<f64>,
    delete_time_ms: Option<f64>,
    last_query_time_ms: Option<f64>,
    distance_computations: i64,
    nodes_visited: i64,
    pages_read: i64,
    candidates_inspected: i64,
    pruned_by_geo: i64,
    pruned_by_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidationReport {
    checked: bool,
    equal: bool,
    compared_with: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoIndexBuildProgress {
    phase: String,
    point_count: usize,
    built_indexes: usize,
    total_indexes: usize,
    current_index_id: Option<String>,
    current_index_label: Option<String>,
    current_index_processed_points: Option<usize>,
    current_index_total_points: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoIndexBuildSummary {
    point_count: usize,
    build_time_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    phase: String,
    source_label: String,
    scanned_files: i64,
    total_files: i64,
    accepted_media: i64,
    skipped_files: i64,
    current_path: Option<String>,
    scanned_bytes: Option<i64>,
    total_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSummary {
    source: MediaSource,
    source_label: String,
    scanned_files: i64,
    total_files: i64,
    accepted_media: i64,
    skipped_files: i64,
    errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedGeoPoint {
    index: i64,
    latitude: f64,
    longitude: f64,
    captured_at: i64,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
struct ParsedGeoFile {
    points: Vec<ParsedGeoPoint>,
    skipped_points: i64,
    mime_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeoFileFormat {
    Gpx,
    GoogleTakeoutJson,
}

#[derive(Default)]
struct NativeMetadata {
    width: Option<i64>,
    height: Option<i64>,
    captured_at: Option<i64>,
    captured_at_source: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    geo_source: Option<String>,
}

#[derive(Clone)]
struct NativeCell {
    z: u32,
    lat_min: f64,
    lat_max: f64,
    min_captured_at: Option<i64>,
    max_captured_at: Option<i64>,
    points: Vec<GeoIndexPoint>,
}

#[derive(Clone)]
struct NativeBruteForceIndex {
    points: Vec<GeoIndexPoint>,
    last_stats: GeoIndexStats,
}

#[derive(Clone)]
struct NativeDynamicZOrderIndex {
    cells: HashMap<String, NativeCell>,
    point_count: usize,
    last_stats: GeoIndexStats,
}

#[derive(Clone)]
struct NativeGeoIndexRegistry {
    brute_force: NativeBruteForceIndex,
    dynamic_z_order: NativeDynamicZOrderIndex,
}

const EARTH_RADIUS_METERS: f64 = 6_371_008.8;
const DISTANCE_TIE_EPSILON_METERS: f64 = 1e-6;
const DYNAMIC_Z_ORDER_RESOLUTION: u32 = 10;

static GEO_INDEX_REGISTRY: OnceLock<Mutex<NativeGeoIndexRegistry>> = OnceLock::new();

fn geo_index_registry() -> &'static Mutex<NativeGeoIndexRegistry> {
    GEO_INDEX_REGISTRY.get_or_init(|| Mutex::new(NativeGeoIndexRegistry::default()))
}

impl Default for NativeGeoIndexRegistry {
    fn default() -> Self {
        Self {
            brute_force: NativeBruteForceIndex::default(),
            dynamic_z_order: NativeDynamicZOrderIndex::default(),
        }
    }
}

impl Default for NativeBruteForceIndex {
    fn default() -> Self {
        Self {
            points: Vec::new(),
            last_stats: empty_geo_index_stats("brute-force", 0),
        }
    }
}

impl Default for NativeDynamicZOrderIndex {
    fn default() -> Self {
        Self {
            cells: HashMap::new(),
            point_count: 0,
            last_stats: empty_geo_index_stats("dynamic-z-order-cells", 0),
        }
    }
}

fn empty_geo_index_stats(engine_id: &str, point_count: usize) -> GeoIndexStats {
    GeoIndexStats {
        engine_id: engine_id.to_string(),
        point_count,
        index_size_bytes: None,
        build_time_ms: None,
        insert_time_ms: None,
        delete_time_ms: None,
        last_query_time_ms: None,
        distance_computations: 0,
        nodes_visited: 0,
        pages_read: 0,
        candidates_inspected: 0,
        pruned_by_geo: 0,
        pruned_by_time: 0,
    }
}

fn to_radians(degrees: f64) -> f64 {
    degrees * std::f64::consts::PI / 180.0
}

fn normalize_lon(lon: f64) -> f64 {
    let normalized = (lon + 180.0).rem_euclid(360.0) - 180.0;
    if normalized == -180.0 {
        180.0
    } else {
        normalized
    }
}

fn distance_meters(point: &GeoIndexPoint, query: &GeoSearchQuery) -> f64 {
    let point_lat = to_radians(point.lat);
    let query_lat = to_radians(query.lat);
    let delta_lat = to_radians(query.lat - point.lat);
    let delta_lon = to_radians(query.lon - point.lon);
    let a = (delta_lat / 2.0).sin().powi(2)
        + point_lat.cos() * query_lat.cos() * (delta_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_METERS * a.sqrt().atan2((1.0 - a).sqrt())
}

fn matches_time_range(captured_at: Option<i64>, query: &GeoSearchQuery) -> bool {
    if let Some(start_time) = query.start_time {
        if captured_at.is_none_or(|value| value < start_time) {
            return false;
        }
    }
    if let Some(end_time) = query.end_time {
        if captured_at.is_none_or(|value| value > end_time) {
            return false;
        }
    }
    true
}

fn matches_kind(point: &GeoIndexPoint, query: &GeoSearchQuery) -> bool {
    match query.kind.as_deref() {
        None | Some("all") => true,
        Some("media") => matches!(point.kind.as_deref(), Some("image" | "video")),
        Some(kind) => point.kind.as_deref() == Some(kind),
    }
}

fn matches_geo_bounds(point: &GeoIndexPoint, query: &GeoSearchQuery) -> bool {
    let Some(bounds) = query.geo_bounds.as_ref() else {
        return true;
    };
    point.lat >= bounds.min_lat
        && point.lat <= bounds.max_lat
        && point.lon >= bounds.min_lon
        && point.lon <= bounds.max_lon
}

fn matches_geo_search_query(point: &GeoIndexPoint, query: &GeoSearchQuery) -> bool {
    matches_time_range(point.captured_at, query)
        && matches_kind(point, query)
        && matches_geo_bounds(point, query)
}

fn overlaps_time_range(
    min_captured_at: Option<i64>,
    max_captured_at: Option<i64>,
    query: &GeoSearchQuery,
) -> bool {
    if let Some(start_time) = query.start_time {
        if max_captured_at.is_some_and(|value| value < start_time) {
            return false;
        }
    }
    if let Some(end_time) = query.end_time {
        if min_captured_at.is_some_and(|value| value > end_time) {
            return false;
        }
    }
    true
}

fn sort_geo_results(results: &mut [GeoSearchResult]) {
    results.sort_by(|a, b| {
        let distance_delta = a.distance_meters - b.distance_meters;
        if distance_delta.abs() > DISTANCE_TIE_EPSILON_METERS {
            a.distance_meters
                .partial_cmp(&b.distance_meters)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a.media_id.cmp(&b.media_id)
        }
    });
}

impl NativeBruteForceIndex {
    fn build(&mut self, points: &[GeoIndexPoint]) {
        let start = Instant::now();
        self.points = points.to_vec();
        self.points.sort_by(|a, b| a.media_id.cmp(&b.media_id));
        self.last_stats = GeoIndexStats {
            build_time_ms: Some(start.elapsed().as_secs_f64() * 1000.0),
            ..empty_geo_index_stats("brute-force", self.points.len())
        };
    }

    fn search(&mut self, query: &GeoSearchQuery) -> Vec<GeoSearchResult> {
        let start = Instant::now();
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.k.max(0) as usize;
        let mut distance_computations = 0_i64;
        let mut candidates_inspected = 0_i64;
        let mut results = Vec::new();

        for point in &self.points {
            candidates_inspected += 1;
            if !matches_geo_search_query(point, query) {
                continue;
            }
            distance_computations += 1;
            results.push(GeoSearchResult {
                media_id: point.media_id.clone(),
                distance_meters: distance_meters(point, query),
            });
        }
        sort_geo_results(&mut results);
        results = results
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();

        self.last_stats = GeoIndexStats {
            last_query_time_ms: Some(start.elapsed().as_secs_f64() * 1000.0),
            distance_computations,
            candidates_inspected,
            ..empty_geo_index_stats("brute-force", self.points.len())
        };
        results
    }
}

impl NativeDynamicZOrderIndex {
    fn build(
        &mut self,
        points: &[GeoIndexPoint],
        mut on_progress: impl FnMut(usize) -> AppResult<()>,
    ) -> AppResult<()> {
        let start = Instant::now();
        self.cells.clear();
        self.point_count = 0;
        on_progress(0)?;

        for (index, point) in points.iter().enumerate() {
            self.insert_internal(point);
            if (index + 1) % 2_000 == 0 {
                on_progress(index + 1)?;
            }
        }
        on_progress(points.len())?;
        self.last_stats = GeoIndexStats {
            index_size_bytes: Some(self.point_count * 48 + self.cells.len() * 96),
            build_time_ms: Some(start.elapsed().as_secs_f64() * 1000.0),
            ..empty_geo_index_stats("dynamic-z-order-cells", self.point_count)
        };
        Ok(())
    }

    fn search(&mut self, query: &GeoSearchQuery) -> Vec<GeoSearchResult> {
        let start = Instant::now();
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.k.max(0) as usize;
        let retained_limit = offset + limit;
        let mut stats = empty_geo_index_stats("dynamic-z-order-cells", self.point_count);
        if limit == 0 || self.cells.is_empty() {
            stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            self.last_stats = stats;
            return Vec::new();
        }

        let mut candidates = Vec::<(&NativeCell, f64)>::new();
        for cell in self.cells.values() {
            if !overlaps_time_range(cell.min_captured_at, cell.max_captured_at, query) {
                stats.pruned_by_time += 1;
                continue;
            }
            candidates.push((cell, cell_lower_bound_meters(cell, query)));
        }
        candidates.sort_by(|(a_cell, a_distance), (b_cell, b_distance)| {
            a_distance
                .partial_cmp(b_distance)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a_cell.z.cmp(&b_cell.z))
        });

        let mut top_k = Vec::<GeoSearchResult>::new();
        for (index, (cell, lower_bound)) in candidates.iter().enumerate() {
            let worst = if top_k.len() == retained_limit {
                top_k
                    .last()
                    .map(|result| result.distance_meters)
                    .unwrap_or(f64::INFINITY)
            } else {
                f64::INFINITY
            };
            if top_k.len() == retained_limit && *lower_bound > worst {
                stats.pruned_by_geo += (candidates.len() - index) as i64;
                break;
            }

            stats.nodes_visited += 1;
            stats.pages_read += 1;
            let mut points = cell.points.clone();
            points.sort_by(|a, b| a.media_id.cmp(&b.media_id));
            for point in points {
                stats.candidates_inspected += 1;
                if !matches_geo_search_query(&point, query) {
                    continue;
                }
                stats.distance_computations += 1;
                top_k.push(GeoSearchResult {
                    media_id: point.media_id.clone(),
                    distance_meters: distance_meters(&point, query),
                });
                if top_k.len() >= retained_limit {
                    sort_geo_results(&mut top_k);
                    top_k.truncate(retained_limit);
                }
            }
        }

        sort_geo_results(&mut top_k);
        stats.index_size_bytes = Some(self.point_count * 48 + self.cells.len() * 96);
        stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
        self.last_stats = stats;
        top_k
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>()
    }

    fn insert_internal(&mut self, point: &GeoIndexPoint) {
        if !point.lat.is_finite() || !point.lon.is_finite() {
            return;
        }

        let normalized = GeoIndexPoint {
            media_id: point.media_id.clone(),
            kind: point.kind.clone(),
            lat: point.lat,
            lon: normalize_lon(point.lon),
            captured_at: point.captured_at,
        };
        let (key, z, lat_min, lat_max) = cell_address(&normalized);
        let cell = self.cells.entry(key).or_insert_with(|| NativeCell {
            z,
            lat_min,
            lat_max,
            min_captured_at: None,
            max_captured_at: None,
            points: Vec::new(),
        });
        update_cell_time_range(cell, normalized.captured_at);
        cell.points.push(normalized);
        self.point_count += 1;
    }
}

fn cell_address(point: &GeoIndexPoint) -> (String, u32, f64, f64) {
    let axis_size = 2_i64.pow(DYNAMIC_Z_ORDER_RESOLUTION);
    let x = ((((normalize_lon(point.lon) + 180.0) / 360.0) * axis_size as f64).floor() as i64)
        .clamp(0, axis_size - 1);
    let y =
        ((((point.lat + 90.0) / 180.0) * axis_size as f64).floor() as i64).clamp(0, axis_size - 1);
    let z = interleave_morton(x as u32, y as u32);
    let lat_step = 180.0 / axis_size as f64;
    let lat_min = y as f64 * lat_step - 90.0;
    let lat_max = (y + 1) as f64 * lat_step - 90.0;
    (
        format!("{DYNAMIC_Z_ORDER_RESOLUTION}:{z}"),
        z,
        lat_min,
        lat_max,
    )
}

fn interleave_morton(x: u32, y: u32) -> u32 {
    let mut z = 0_u32;
    for bit in 0..16 {
        z |= ((x >> bit) & 1) << (2 * bit);
        z |= ((y >> bit) & 1) << (2 * bit + 1);
    }
    z
}

fn update_cell_time_range(cell: &mut NativeCell, captured_at: Option<i64>) {
    let Some(captured_at) = captured_at else {
        return;
    };
    if cell.min_captured_at.is_none_or(|value| captured_at < value) {
        cell.min_captured_at = Some(captured_at);
    }
    if cell.max_captured_at.is_none_or(|value| captured_at > value) {
        cell.max_captured_at = Some(captured_at);
    }
}

fn cell_lower_bound_meters(cell: &NativeCell, query: &GeoSearchQuery) -> f64 {
    if query.lat < cell.lat_min {
        EARTH_RADIUS_METERS * to_radians(cell.lat_min - query.lat)
    } else if query.lat > cell.lat_max {
        EARTH_RADIUS_METERS * to_radians(query.lat - cell.lat_max)
    } else {
        0.0
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn app_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn app_cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn catalog_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_dir(app)?.join("catalog.sqlite3"))
}

fn connect(app: &AppHandle) -> AppResult<Connection> {
    let path = catalog_path(app)?;
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS media_sources (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          added_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_assets (
          content_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          duration_ms INTEGER,
          captured_at INTEGER,
          captured_at_source TEXT,
          latitude REAL,
          longitude REAL,
          geo_source TEXT,
          thumbnail_key TEXT,
          deleted_at INTEGER,
          last_seen_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_locations (
          id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          source_id TEXT NOT NULL,
          relative_path TEXT,
          absolute_path TEXT NOT NULL,
          display_name TEXT NOT NULL,
          deleted_at INTEGER,
          last_seen_at INTEGER NOT NULL,
          FOREIGN KEY(content_hash) REFERENCES media_assets(content_hash) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_assets_captured_at
          ON media_assets(captured_at);
        CREATE INDEX IF NOT EXISTS idx_media_assets_kind
          ON media_assets(kind);
        CREATE INDEX IF NOT EXISTS idx_media_assets_geo
          ON media_assets(latitude, longitude);
        CREATE INDEX IF NOT EXISTS idx_media_assets_deleted
          ON media_assets(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
          ON media_locations(content_hash);
        CREATE INDEX IF NOT EXISTS idx_media_locations_source
          ON media_locations(source_id);
        CREATE INDEX IF NOT EXISTS idx_media_locations_source_path
          ON media_locations(source_id, absolute_path);
        CREATE INDEX IF NOT EXISTS idx_media_locations_deleted
          ON media_locations(deleted_at);
        ",
    )
    .map_err(|error| error.to_string())?;

    migrate_media_locations_schema(conn)
}

fn migrate_media_locations_schema(conn: &Connection) -> AppResult<()> {
    let table_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_locations'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    if !table_sql
        .as_deref()
        .unwrap_or_default()
        .contains("UNIQUE(source_id, absolute_path)")
    {
        return Ok(());
    }

    conn.execute_batch(
        "
        PRAGMA foreign_keys = OFF;
        ALTER TABLE media_locations RENAME TO media_locations_old;
        CREATE TABLE media_locations (
          id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          source_id TEXT NOT NULL,
          relative_path TEXT,
          absolute_path TEXT NOT NULL,
          display_name TEXT NOT NULL,
          deleted_at INTEGER,
          last_seen_at INTEGER NOT NULL,
          FOREIGN KEY(content_hash) REFERENCES media_assets(content_hash) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO media_locations (
          id, content_hash, source_id, relative_path, absolute_path, display_name,
          deleted_at, last_seen_at
        )
        SELECT
          id, content_hash, source_id, relative_path, absolute_path, display_name,
          deleted_at, last_seen_at
        FROM media_locations_old;
        DROP TABLE media_locations_old;
        PRAGMA foreign_keys = ON;

        CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
          ON media_locations(content_hash);
        CREATE INDEX IF NOT EXISTS idx_media_locations_source
          ON media_locations(source_id);
        CREATE INDEX IF NOT EXISTS idx_media_locations_source_path
          ON media_locations(source_id, absolute_path);
        CREATE INDEX IF NOT EXISTS idx_media_locations_deleted
          ON media_locations(deleted_at);
        ",
    )
    .map_err(|error| error.to_string())
}

fn sha256_string(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn geo_point_identity_input(latitude: f64, longitude: f64, captured_at: i64) -> String {
    format!("geo_point:v1\n{latitude:.9}\n{longitude:.9}\n{captured_at}")
}

fn geo_point_content_hash(latitude: f64, longitude: f64, captured_at: i64) -> String {
    sha256_string(&geo_point_identity_input(latitude, longitude, captured_at))
}

fn parse_gpx_time(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|date| date.timestamp_millis())
}

fn parse_json_timestamp(value: &JsonValue) -> Option<i64> {
    value
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value.trim()).ok())
        .map(|date| date.timestamp_millis())
}

fn parse_json_timestamp_ms(value: &JsonValue) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn json_number(value: Option<&JsonValue>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

#[cfg(test)]
fn is_google_takeout_location_json(value: &JsonValue) -> bool {
    value
        .get("locations")
        .and_then(|value| value.as_array())
        .is_some()
}

#[cfg(test)]
fn is_google_semantic_location_json(value: &JsonValue) -> bool {
    value
        .get("timelineObjects")
        .and_then(|value| value.as_array())
        .is_some()
}

#[cfg(test)]
fn is_geojson(value: &JsonValue) -> bool {
    matches!(
        value.get("type").and_then(|value| value.as_str()),
        Some("FeatureCollection" | "Feature" | "Point")
    )
}

#[cfg(test)]
fn json_value_kind(value: Option<&JsonValue>) -> &'static str {
    match value {
        Some(JsonValue::Array(_)) => "array",
        Some(JsonValue::Bool(_)) => "boolean",
        Some(JsonValue::Null) => "null",
        Some(JsonValue::Number(_)) => "number",
        Some(JsonValue::Object(_)) => "object",
        Some(JsonValue::String(_)) => "string",
        None => "missing",
    }
}

#[cfg(test)]
fn sample_json_keys(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(|value| value.as_object())
        .map(|object| object.keys().take(12).cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
fn geo_import_debug_json(path: &Path, reason: &str, parsed: &JsonValue) {
    let locations = parsed.get("locations");
    let timeline_objects = parsed.get("timelineObjects");
    let first_location = locations
        .and_then(|value| value.as_array())
        .and_then(|items| items.first());
    let first_timeline_object = timeline_objects
        .and_then(|value| value.as_array())
        .and_then(|items| items.first());

    eprintln!(
        "[geo-import] file={} reason={} rootKind={} topLevelKeys={:?} locationsKind={} locationsCount={:?} firstLocationKeys={:?} timelineObjectsKind={} timelineObjectsCount={:?} firstTimelineObjectKeys={:?}",
        path.display(),
        reason,
        json_value_kind(Some(parsed)),
        sample_json_keys(Some(parsed)),
        json_value_kind(locations),
        locations.and_then(|value| value.as_array()).map(|items| items.len()),
        sample_json_keys(first_location),
        json_value_kind(timeline_objects),
        timeline_objects
            .and_then(|value| value.as_array())
            .map(|items| items.len()),
        sample_json_keys(first_timeline_object),
    );
}

fn geo_import_debug_text(path: &Path, reason: &str, text: &str) {
    let first_characters = text.trim_start().chars().take(32).collect::<String>();
    eprintln!(
        "[geo-import] file={} reason={} firstCharacters={:?}",
        path.display(),
        reason,
        first_characters
    );
}

fn unsupported_geo_file_format_message() -> String {
    "The selected file is not a supported geo import format. Supported formats are GPX and Google Takeout Location History JSON.".to_string()
}

#[cfg(test)]
fn detect_geo_file_format(path: &Path, text: &str) -> AppResult<GeoFileFormat> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        geo_import_debug_text(path, "empty file", text);
        return Err(unsupported_geo_file_format_message());
    }

    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        match serde_json::from_str::<JsonValue>(text) {
            Ok(parsed) => {
                if is_google_takeout_location_json(&parsed) {
                    return Ok(GeoFileFormat::GoogleTakeoutJson);
                }
                if is_google_semantic_location_json(&parsed) {
                    geo_import_debug_json(
                        path,
                        "Google Semantic Location History is not supported yet",
                        &parsed,
                    );
                    return Err("This looks like Google Semantic Location History JSON. That is valid Google Takeout data, but this importer currently supports only the raw Records.json location export.".to_string());
                }
                if is_geojson(&parsed) {
                    geo_import_debug_json(path, "GeoJSON is not supported yet", &parsed);
                    return Err("GeoJSON files are not supported yet. Supported formats are GPX and Google Takeout Location History JSON.".to_string());
                }

                geo_import_debug_json(path, "unsupported JSON geo format", &parsed);
                return Err("The selected JSON file is not a supported geo import format. Supported JSON format is Google Takeout Location History JSON.".to_string());
            }
            Err(error) => {
                geo_import_debug_text(path, &format!("JSON parse failed: {error}"), text);
                return Err(unsupported_geo_file_format_message());
            }
        }
    }

    if let Ok(document) = roxmltree::Document::parse(text) {
        if document.root_element().tag_name().name() == "gpx" {
            return Ok(GeoFileFormat::Gpx);
        }
    }

    geo_import_debug_text(path, "unsupported non-JSON/non-GPX content", text);
    Err(unsupported_geo_file_format_message())
}

fn valid_latitude(value: f64) -> bool {
    value.is_finite() && (-90.0..=90.0).contains(&value)
}

fn valid_longitude(value: f64) -> bool {
    value.is_finite() && (-180.0..=180.0).contains(&value)
}

#[cfg(test)]
fn parse_gpx_points(xml: &str) -> AppResult<ParsedGeoFile> {
    let document = roxmltree::Document::parse(xml).map_err(|error| error.to_string())?;
    let mut points = Vec::<ParsedGeoPoint>::new();
    let mut skipped_points = 0_i64;
    let mut index = 0_i64;

    for node in document.descendants().filter(|node| node.is_element()) {
        if !matches!(node.tag_name().name(), "trkpt" | "rtept" | "wpt") {
            continue;
        }

        index += 1;
        let latitude = node.attribute("lat").and_then(|value| value.parse().ok());
        let longitude = node.attribute("lon").and_then(|value| value.parse().ok());
        let captured_at = node
            .children()
            .find(|child| child.is_element() && child.tag_name().name() == "time")
            .and_then(|child| child.text())
            .and_then(parse_gpx_time);

        match (latitude, longitude, captured_at) {
            (Some(latitude), Some(longitude), Some(captured_at))
                if valid_latitude(latitude) && valid_longitude(longitude) =>
            {
                points.push(ParsedGeoPoint {
                    index,
                    latitude,
                    longitude,
                    captured_at,
                });
            }
            _ => {
                skipped_points += 1;
            }
        }
    }

    Ok(ParsedGeoFile {
        points,
        skipped_points,
        mime_type: "application/gpx+xml".to_string(),
    })
}

#[cfg(test)]
fn parse_google_takeout_location_points(json: &str) -> AppResult<ParsedGeoFile> {
    let parsed: JsonValue = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let locations = parsed
        .get("locations")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            "The selected JSON file does not look like a Google Takeout location export."
                .to_string()
        })?;
    let mut points = Vec::<ParsedGeoPoint>::new();
    let mut skipped_points = 0_i64;

    for (entry_index, entry) in locations.iter().enumerate() {
        let index = entry_index as i64 + 1;
        if let Some(point) = parse_google_takeout_location_entry(entry, index) {
            points.push(point);
        } else {
            skipped_points += 1;
        }
    }

    Ok(ParsedGeoFile {
        points,
        skipped_points,
        mime_type: "application/json".to_string(),
    })
}

#[cfg(test)]
fn parse_geo_file_points(path: &Path, text: &str) -> AppResult<ParsedGeoFile> {
    match detect_geo_file_format(path, text)? {
        GeoFileFormat::GoogleTakeoutJson => parse_google_takeout_location_points(text),
        GeoFileFormat::Gpx => parse_gpx_points(text),
    }
}

fn detect_geo_file_format_from_prefix(path: &Path, prefix: &str) -> AppResult<GeoFileFormat> {
    let trimmed = prefix.trim_start();
    if trimmed.is_empty() {
        geo_import_debug_text(path, "empty prefix", prefix);
        return Err(unsupported_geo_file_format_message());
    }

    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if trimmed.contains("\"timelineObjects\"") {
            return Err("This looks like Google Semantic Location History JSON. That is valid Google Takeout data, but this importer currently supports only the raw Records.json location export.".to_string());
        }
        if trimmed.contains("\"FeatureCollection\"")
            || trimmed.contains("\"Feature\"")
            || trimmed.contains("\"Point\"")
        {
            return Err("GeoJSON files are not supported yet. Supported formats are GPX and Google Takeout Location History JSON.".to_string());
        }
        return Ok(GeoFileFormat::GoogleTakeoutJson);
    }

    if trimmed.contains("<gpx") || extension(path).as_deref() == Some("gpx") {
        return Ok(GeoFileFormat::Gpx);
    }

    geo_import_debug_text(path, "unsupported non-JSON/non-GPX prefix", prefix);
    Err(unsupported_geo_file_format_message())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TakeoutStreamPhase {
    BeforeLocations,
    BeforeArray,
    InArray,
    Done,
}

struct GoogleTakeoutLocationStreamParser {
    phase: TakeoutStreamPhase,
    buffer: String,
    skipped_points: i64,
    total_entries: i64,
}

impl GoogleTakeoutLocationStreamParser {
    fn new() -> Self {
        Self {
            phase: TakeoutStreamPhase::BeforeLocations,
            buffer: String::new(),
            skipped_points: 0,
            total_entries: 0,
        }
    }

    fn feed(&mut self, chunk: &str) -> AppResult<Vec<ParsedGeoPoint>> {
        if self.phase == TakeoutStreamPhase::Done {
            return Ok(Vec::new());
        }

        self.buffer.push_str(chunk);
        let mut points = Vec::<ParsedGeoPoint>::new();

        loop {
            if self.phase == TakeoutStreamPhase::BeforeLocations {
                let Some(location_index) = self.buffer.find("\"locations\"") else {
                    let keep = "\"locations\"".len().saturating_sub(1);
                    if self.buffer.chars().count() > keep {
                        self.buffer = self
                            .buffer
                            .chars()
                            .rev()
                            .take(keep)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect();
                    }
                    break;
                };
                self.buffer = self.buffer[location_index + "\"locations\"".len()..].to_string();
                self.phase = TakeoutStreamPhase::BeforeArray;
            }

            if self.phase == TakeoutStreamPhase::BeforeArray {
                let Some(array_start) = self.buffer.find('[') else {
                    break;
                };
                self.buffer = self.buffer[array_start + 1..].to_string();
                self.phase = TakeoutStreamPhase::InArray;
            }

            if self.phase != TakeoutStreamPhase::InArray {
                continue;
            }

            let separator_length = leading_json_separator_length(&self.buffer);
            if separator_length > 0 {
                self.buffer = self.buffer[separator_length..].to_string();
            }

            if self.buffer.is_empty() {
                break;
            }
            if self.buffer.starts_with(']') {
                self.phase = TakeoutStreamPhase::Done;
                self.buffer.clear();
                break;
            }
            if !self.buffer.starts_with('{') {
                return Err("The selected JSON file does not look like raw Google Takeout Records.json data.".to_string());
            }

            let Some(end_offset) = complete_json_object_end_offset(&self.buffer) else {
                break;
            };
            let object_text = self.buffer[..end_offset].to_string();
            self.buffer = self.buffer[end_offset..].to_string();
            self.total_entries += 1;

            let parsed = serde_json::from_str::<JsonValue>(&object_text)
                .map_err(|error| error.to_string())?;
            if let Some(point) = parse_google_takeout_location_entry(&parsed, self.total_entries) {
                points.push(point);
            } else {
                self.skipped_points += 1;
            }
        }

        Ok(points)
    }

    fn finish(&mut self) -> AppResult<()> {
        self.feed("")?;
        if self.phase == TakeoutStreamPhase::BeforeLocations {
            return Err("The selected JSON file is not a supported geo import format. Expected raw Google Takeout Records.json with a locations array.".to_string());
        }
        if self.phase != TakeoutStreamPhase::Done {
            return Err(
                "The selected Google Takeout JSON file ended before the locations array was complete."
                    .to_string(),
            );
        }
        Ok(())
    }
}

fn complete_json_object_end_offset(buffer: &str) -> Option<usize> {
    if !buffer.starts_with('{') {
        return None;
    }

    let mut depth = 0_i64;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in buffer.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        if character == '"' {
            in_string = true;
        } else if character == '{' {
            depth += 1;
        } else if character == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(index + character.len_utf8());
            }
        }
    }

    None
}

fn leading_json_separator_length(buffer: &str) -> usize {
    let mut length = 0;
    for character in buffer.chars() {
        if matches!(character, ',' | '\n' | '\r' | '\t' | ' ') {
            length += character.len_utf8();
        } else {
            break;
        }
    }
    length
}

struct PendingGpxPoint {
    index: i64,
    latitude: Option<f64>,
    longitude: Option<f64>,
    time_text: String,
    in_time: bool,
}

enum GpxStreamEvent {
    Point(ParsedGeoPoint, u64),
    Skipped(i64, u64),
}

fn stream_gpx_points(
    path: &Path,
    mut on_event: impl FnMut(GpxStreamEvent) -> AppResult<()>,
) -> AppResult<i64> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = XmlReader::from_reader(BufReader::new(file));
    reader.config_mut().trim_text(true);

    let mut buffer = Vec::new();
    let mut current: Option<PendingGpxPoint> = None;
    let mut index = 0_i64;
    let mut skipped_points = 0_i64;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(XmlEvent::Start(element)) => {
                let local_name = element.local_name();
                if matches!(local_name.as_ref(), b"trkpt" | b"rtept" | b"wpt") {
                    index += 1;
                    let mut latitude = None;
                    let mut longitude = None;
                    for attribute in element.attributes() {
                        let attribute = attribute.map_err(|error| error.to_string())?;
                        let value = attribute
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|error| error.to_string())?;
                        match attribute.key.as_ref() {
                            b"lat" => latitude = value.parse::<f64>().ok(),
                            b"lon" => longitude = value.parse::<f64>().ok(),
                            _ => {}
                        }
                    }
                    current = Some(PendingGpxPoint {
                        index,
                        latitude,
                        longitude,
                        time_text: String::new(),
                        in_time: false,
                    });
                } else if local_name.as_ref() == b"time" {
                    if let Some(point) = current.as_mut() {
                        point.in_time = true;
                        point.time_text.clear();
                    }
                }
            }
            Ok(XmlEvent::Text(text)) => {
                if let Some(point) = current.as_mut().filter(|point| point.in_time) {
                    let decoded = text.decode().map_err(|error| error.to_string())?;
                    point.time_text.push_str(&decoded);
                }
            }
            Ok(XmlEvent::End(element)) => {
                let local_name = element.local_name();
                if local_name.as_ref() == b"time" {
                    if let Some(point) = current.as_mut() {
                        point.in_time = false;
                    }
                } else if matches!(local_name.as_ref(), b"trkpt" | b"rtept" | b"wpt") {
                    if let Some(point) = current.take() {
                        let captured_at = parse_gpx_time(point.time_text.trim());
                        match (point.latitude, point.longitude, captured_at) {
                            (Some(latitude), Some(longitude), Some(captured_at))
                                if valid_latitude(latitude) && valid_longitude(longitude) =>
                            {
                                on_event(GpxStreamEvent::Point(
                                    ParsedGeoPoint {
                                        index: point.index,
                                        latitude,
                                        longitude,
                                        captured_at,
                                    },
                                    reader.buffer_position(),
                                ))?;
                            }
                            _ => {
                                skipped_points += 1;
                                on_event(GpxStreamEvent::Skipped(
                                    skipped_points,
                                    reader.buffer_position(),
                                ))?;
                            }
                        }
                    }
                }
            }
            Ok(XmlEvent::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }

    Ok(skipped_points)
}

fn parse_google_takeout_location_entry(entry: &JsonValue, index: i64) -> Option<ParsedGeoPoint> {
    let latitude = json_number(entry.get("latitudeE7")).map(|value| value / 10_000_000.0);
    let longitude = json_number(entry.get("longitudeE7")).map(|value| value / 10_000_000.0);
    let captured_at = entry
        .get("timestamp")
        .and_then(parse_json_timestamp)
        .or_else(|| entry.get("timestampMs").and_then(parse_json_timestamp_ms))
        .or_else(|| entry.get("timestampMS").and_then(parse_json_timestamp_ms));

    match (latitude, longitude, captured_at) {
        (Some(latitude), Some(longitude), Some(captured_at))
            if valid_latitude(latitude) && valid_longitude(longitude) =>
        {
            Some(ParsedGeoPoint {
                index,
                latitude,
                longitude,
                captured_at,
            })
        }
        _ => None,
    }
}

fn file_hash(path: &Path) -> AppResult<String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

fn detect_media_kind(path: &Path) -> Option<&'static str> {
    match extension(path).as_deref() {
        Some(
            "jpg" | "jpeg" | "png" | "webp" | "gif" | "heic" | "heif" | "tif" | "tiff" | "avif",
        ) => Some("image"),
        Some("mp4" | "mov" | "m4v" | "webm" | "avi" | "mkv" | "3gp") => Some("video"),
        _ => None,
    }
}

fn mime_type(path: &Path, kind: &str) -> String {
    match extension(path).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("tif" | "tiff") => "image/tiff",
        Some("avif") => "image/avif",
        Some("heic" | "heif") => "image/heif",
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("avi") => "video/x-msvideo",
        Some("mkv") => "video/x-matroska",
        Some("3gp") => "video/3gpp",
        _ if kind == "image" => "image/*",
        _ => "video/*",
    }
    .to_string()
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn modified_ms(path: &Path) -> Option<i64> {
    path.metadata()
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
}

fn rational_to_f64(value: exif::Rational) -> Option<f64> {
    if value.denom == 0 {
        return None;
    }
    Some(value.num as f64 / value.denom as f64)
}

fn gps_coordinate(value: &ExifValue) -> Option<f64> {
    match value {
        ExifValue::Rational(values) if values.len() >= 3 => Some(
            rational_to_f64(values[0])?
                + rational_to_f64(values[1])? / 60.0
                + rational_to_f64(values[2])? / 3600.0,
        ),
        _ => None,
    }
}

fn exif_ascii(field: &exif::Field) -> Option<String> {
    match &field.value {
        ExifValue::Ascii(values) => values.first().map(|bytes| {
            String::from_utf8_lossy(bytes)
                .trim_matches(char::from(0))
                .trim()
                .to_string()
        }),
        _ => None,
    }
}

fn parse_exif_date(value: &str) -> Option<i64> {
    NaiveDateTime::parse_from_str(value, "%Y:%m:%d %H:%M:%S")
        .ok()
        .map(|date| date.and_utc().timestamp_millis())
}

fn read_image_metadata(path: &Path) -> NativeMetadata {
    let mut metadata = NativeMetadata::default();

    if let Ok((width, height)) = image::image_dimensions(path) {
        metadata.width = Some(width as i64);
        metadata.height = Some(height as i64);
    }

    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return metadata,
    };
    let mut reader = BufReader::new(file);
    let exif = match ExifReader::new().read_from_container(&mut reader) {
        Ok(exif) => exif,
        Err(_) => return metadata,
    };

    if metadata.captured_at.is_none() {
        for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
            if let Some(field) = exif.get_field(tag, In::PRIMARY) {
                if let Some(value) = exif_ascii(field).and_then(|value| parse_exif_date(&value)) {
                    metadata.captured_at = Some(value);
                    metadata.captured_at_source = Some("exif".to_string());
                    break;
                }
            }
        }
    }

    let latitude = exif
        .get_field(Tag::GPSLatitude, In::PRIMARY)
        .and_then(|field| gps_coordinate(&field.value));
    let longitude = exif
        .get_field(Tag::GPSLongitude, In::PRIMARY)
        .and_then(|field| gps_coordinate(&field.value));
    let lat_ref = exif
        .get_field(Tag::GPSLatitudeRef, In::PRIMARY)
        .and_then(exif_ascii)
        .unwrap_or_default();
    let lon_ref = exif
        .get_field(Tag::GPSLongitudeRef, In::PRIMARY)
        .and_then(exif_ascii)
        .unwrap_or_default();

    if let (Some(mut lat), Some(mut lon)) = (latitude, longitude) {
        if lat_ref.eq_ignore_ascii_case("S") {
            lat *= -1.0;
        }
        if lon_ref.eq_ignore_ascii_case("W") {
            lon *= -1.0;
        }
        metadata.latitude = Some(lat);
        metadata.longitude = Some(lon);
        metadata.geo_source = Some("exif".to_string());
    }

    metadata
}

fn write_thumbnail(app: &AppHandle, content_hash: &str, path: &Path) -> Option<String> {
    let thumb_dir = app_cache_dir(app).ok()?.join("thumbs");
    fs::create_dir_all(&thumb_dir).ok()?;
    let thumb_path = thumb_dir.join(format!("{content_hash}.webp"));

    if thumb_path.exists() {
        return Some(format!("thumbs/{content_hash}.webp"));
    }

    let image = image::open(path).ok()?;
    let thumbnail = image.thumbnail(360, 360);
    thumbnail
        .save_with_format(&thumb_path, ImageFormat::WebP)
        .ok()?;
    Some(format!("thumbs/{content_hash}.webp"))
}

fn media_from_path(
    app: &AppHandle,
    source_id: &str,
    root: &Path,
    path: &Path,
) -> AppResult<Option<MediaItem>> {
    let kind = match detect_media_kind(path) {
        Some(kind) => kind,
        None => return Ok(None),
    };
    let absolute_path = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    let relative_path = relative_path(root, path);
    let content_hash = file_hash(path)?;
    let location_id = sha256_string(&format!("{source_id}\n{absolute_path}"));
    let last_seen_at = now_ms();
    let location = MediaLocation {
        id: location_id,
        source_id: source_id.to_string(),
        relative_path: Some(relative_path.clone()),
        absolute_path: Some(absolute_path),
        display_name: display_name(path),
        deleted_at: None,
        last_seen_at,
    };
    let size_bytes = path
        .metadata()
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    let mut item = MediaItem {
        id: content_hash.clone(),
        content_hash: content_hash.clone(),
        source_id: source_id.to_string(),
        relative_path,
        display_name: location.display_name.clone(),
        kind: kind.to_string(),
        mime_type: mime_type(path, kind),
        size_bytes,
        width: None,
        height: None,
        duration_ms: None,
        captured_at: modified_ms(path),
        captured_at_source: modified_ms(path).map(|_| "filesystem".to_string()),
        latitude: None,
        longitude: None,
        geo_source: None,
        thumbnail_key: None,
        deleted_at: None,
        last_seen_at,
        locations: vec![location],
    };

    if kind == "image" {
        let metadata = read_image_metadata(path);
        item.width = metadata.width;
        item.height = metadata.height;
        item.captured_at = metadata.captured_at.or(item.captured_at);
        item.captured_at_source = metadata.captured_at_source.or(item.captured_at_source);
        item.latitude = metadata.latitude;
        item.longitude = metadata.longitude;
        item.geo_source = metadata.geo_source;
        item.thumbnail_key = write_thumbnail(app, &content_hash, path);
    }

    Ok(Some(item))
}

fn source_from_root(root: &Path) -> MediaSource {
    let absolute = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    MediaSource {
        id: sha256_string(&absolute),
        label: root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&absolute)
            .to_string(),
        added_at: now_ms(),
    }
}

fn source_from_file(path: &Path) -> MediaSource {
    let absolute = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    MediaSource {
        id: sha256_string(&absolute),
        label: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&absolute)
            .to_string(),
        added_at: now_ms(),
    }
}

fn geo_point_item_from_parsed_point(
    source: &MediaSource,
    absolute_path: &str,
    mime_type: &str,
    point: &ParsedGeoPoint,
) -> MediaItem {
    let content_hash = geo_point_content_hash(point.latitude, point.longitude, point.captured_at);
    let last_seen_at = now_ms();
    let display_name = format!("{} #{}", source.label, point.index);
    let location = MediaLocation {
        id: sha256_string(&format!(
            "{}\n{}\n{}",
            source.id, absolute_path, content_hash
        )),
        source_id: source.id.clone(),
        relative_path: Some(source.label.clone()),
        absolute_path: Some(absolute_path.to_string()),
        display_name: display_name.clone(),
        deleted_at: None,
        last_seen_at,
    };

    MediaItem {
        id: content_hash.clone(),
        content_hash,
        source_id: source.id.clone(),
        relative_path: source.label.clone(),
        display_name,
        kind: "geo_point".to_string(),
        mime_type: mime_type.to_string(),
        size_bytes: 0,
        width: None,
        height: None,
        duration_ms: None,
        captured_at: Some(point.captured_at),
        captured_at_source: Some("geo-file".to_string()),
        latitude: Some(point.latitude),
        longitude: Some(point.longitude),
        geo_source: Some("geo-file".to_string()),
        thumbnail_key: None,
        deleted_at: None,
        last_seen_at,
        locations: vec![location],
    }
}

fn asset_from_row(row: &Row<'_>) -> rusqlite::Result<MediaItem> {
    let content_hash: String = row.get("content_hash")?;
    Ok(MediaItem {
        id: content_hash.clone(),
        content_hash,
        source_id: String::new(),
        relative_path: String::new(),
        display_name: String::new(),
        kind: row.get("kind")?,
        mime_type: row.get("mime_type")?,
        size_bytes: row.get("size_bytes")?,
        width: row.get("width")?,
        height: row.get("height")?,
        duration_ms: row.get("duration_ms")?,
        captured_at: row.get("captured_at")?,
        captured_at_source: row.get("captured_at_source")?,
        latitude: row.get("latitude")?,
        longitude: row.get("longitude")?,
        geo_source: row.get("geo_source")?,
        thumbnail_key: row.get("thumbnail_key")?,
        deleted_at: row.get("deleted_at")?,
        last_seen_at: row.get("last_seen_at")?,
        locations: Vec::new(),
    })
}

fn location_from_row(row: &Row<'_>) -> rusqlite::Result<MediaLocation> {
    Ok(MediaLocation {
        id: row.get("id")?,
        source_id: row.get("source_id")?,
        relative_path: row.get("relative_path")?,
        absolute_path: row.get("absolute_path")?,
        display_name: row.get("display_name")?,
        deleted_at: row.get("deleted_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

fn attach_locations(
    conn: &Connection,
    items: Vec<MediaItem>,
    preferred_source_id: Option<&str>,
) -> AppResult<Vec<MediaItem>> {
    if items.is_empty() {
        return Ok(items);
    }

    let hashes = items
        .iter()
        .map(|item| item.content_hash.clone())
        .collect::<Vec<_>>();
    let placeholders = hashes.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "
        SELECT *
        FROM media_locations
        WHERE deleted_at IS NULL AND content_hash IN ({placeholders})
        ORDER BY relative_path ASC, absolute_path ASC, id ASC
        "
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(hashes.iter()), location_from_row)
        .map_err(|error| error.to_string())?;
    let mut by_hash = std::collections::HashMap::<String, Vec<MediaLocation>>::new();

    for row in rows {
        let location = row.map_err(|error| error.to_string())?;
        let content_hash: String = conn
            .query_row(
                "SELECT content_hash FROM media_locations WHERE id = ?",
                params![location.id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        by_hash.entry(content_hash).or_default().push(location);
    }

    Ok(items
        .into_iter()
        .map(|mut item| {
            let mut locations = by_hash.remove(&item.content_hash).unwrap_or_default();
            locations.sort_by(|a, b| {
                if let Some(source_id) = preferred_source_id {
                    match (a.source_id == source_id, b.source_id == source_id) {
                        (true, false) => return std::cmp::Ordering::Less,
                        (false, true) => return std::cmp::Ordering::Greater,
                        _ => {}
                    }
                }
                a.relative_path
                    .cmp(&b.relative_path)
                    .then_with(|| a.absolute_path.cmp(&b.absolute_path))
                    .then_with(|| a.id.cmp(&b.id))
            });
            if let Some(primary) = locations.first() {
                item.source_id = primary.source_id.clone();
                item.relative_path = primary.relative_path.clone().unwrap_or_default();
                item.display_name = primary.display_name.clone();
            }
            item.locations = locations;
            item
        })
        .collect())
}

fn upsert_source_tx(conn: &Connection, source: &MediaSource) -> AppResult<()> {
    conn.execute(
        "
        INSERT INTO media_sources (id, label, added_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          added_at = excluded.added_at
        ",
        params![source.id, source.label, source.added_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn value_text(value: &str) -> Value {
    Value::Text(value.to_string())
}

fn value_optional_text(value: &Option<String>) -> Value {
    value
        .as_ref()
        .map(|value| Value::Text(value.clone()))
        .unwrap_or(Value::Null)
}

fn value_optional_i64(value: Option<i64>) -> Value {
    value.map(Value::Integer).unwrap_or(Value::Null)
}

fn value_optional_f64(value: Option<f64>) -> Value {
    value.map(Value::Real).unwrap_or(Value::Null)
}

fn sql_placeholders(row_count: usize, column_count: usize) -> String {
    let row = format!("({})", vec!["?"; column_count].join(", "));
    vec![row; row_count].join(", ")
}

fn exec_multi_row_upsert(
    tx: &rusqlite::Transaction<'_>,
    insert_prefix: &str,
    conflict_clause: &str,
    rows: &[Vec<Value>],
    column_count: usize,
) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }

    let max_rows = (SQLITE_BIND_CHUNK_LIMIT / column_count).max(1);
    for chunk in rows.chunks(max_rows) {
        let sql = format!(
            "{insert_prefix} VALUES {} {conflict_clause}",
            sql_placeholders(chunk.len(), column_count)
        );
        let bind = chunk
            .iter()
            .flat_map(|row| row.iter().cloned())
            .collect::<Vec<_>>();
        tx.execute(&sql, params_from_iter(bind.iter()))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn asset_row(item: &MediaItem) -> Vec<Value> {
    vec![
        value_text(&item.content_hash),
        value_text(&item.kind),
        value_text(&item.mime_type),
        Value::Integer(item.size_bytes),
        value_optional_i64(item.width),
        value_optional_i64(item.height),
        value_optional_i64(item.duration_ms),
        value_optional_i64(item.captured_at),
        value_optional_text(&item.captured_at_source),
        value_optional_f64(item.latitude),
        value_optional_f64(item.longitude),
        value_optional_text(&item.geo_source),
        value_optional_text(&item.thumbnail_key),
        value_optional_i64(item.deleted_at),
        Value::Integer(item.last_seen_at),
    ]
}

fn location_rows(item: &MediaItem) -> Vec<Vec<Value>> {
    item.locations
        .iter()
        .map(|location| {
            let absolute_path = location
                .absolute_path
                .clone()
                .or_else(|| location.relative_path.clone())
                .unwrap_or_else(|| location.id.clone());
            vec![
                value_text(&location.id),
                value_text(&item.content_hash),
                value_text(&location.source_id),
                value_optional_text(&location.relative_path),
                value_text(&absolute_path),
                value_text(&location.display_name),
                value_optional_i64(location.deleted_at),
                Value::Integer(location.last_seen_at),
            ]
        })
        .collect()
}

fn upsert_media_tx(conn: &mut Connection, items: &[MediaItem]) -> AppResult<usize> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let asset_rows = items.iter().map(asset_row).collect::<Vec<_>>();
    exec_multi_row_upsert(
        &tx,
        "
        INSERT INTO media_assets (
          content_hash, kind, mime_type, size_bytes, width, height, duration_ms,
          captured_at, captured_at_source, latitude, longitude, geo_source,
          thumbnail_key, deleted_at, last_seen_at
        )
        ",
        "
        ON CONFLICT(content_hash) DO UPDATE SET
          kind = excluded.kind,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          width = excluded.width,
          height = excluded.height,
          duration_ms = excluded.duration_ms,
          captured_at = excluded.captured_at,
          captured_at_source = excluded.captured_at_source,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          geo_source = excluded.geo_source,
          thumbnail_key = COALESCE(excluded.thumbnail_key, media_assets.thumbnail_key),
          deleted_at = excluded.deleted_at,
          last_seen_at = MAX(media_assets.last_seen_at, excluded.last_seen_at)
        ",
        &asset_rows,
        ASSET_BIND_COLUMNS,
    )?;

    let location_rows = items.iter().flat_map(location_rows).collect::<Vec<_>>();
    exec_multi_row_upsert(
        &tx,
        "
        INSERT INTO media_locations (
          id, content_hash, source_id, relative_path, absolute_path, display_name,
          deleted_at, last_seen_at
        )
        ",
        "
        ON CONFLICT(id) DO UPDATE SET
          content_hash = excluded.content_hash,
          source_id = excluded.source_id,
          relative_path = excluded.relative_path,
          absolute_path = excluded.absolute_path,
          display_name = excluded.display_name,
          deleted_at = excluded.deleted_at,
          last_seen_at = excluded.last_seen_at
        ",
        &location_rows,
        LOCATION_BIND_COLUMNS,
    )?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(items.len())
}

#[tauri::command]
fn init_catalog(app: AppHandle) -> AppResult<CatalogInfo> {
    let conn = connect(&app)?;
    let sqlite_version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(CatalogInfo {
        storage_mode: "native".to_string(),
        sqlite_version,
        filename: catalog_path(&app)?.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn upsert_source(app: AppHandle, source: MediaSource) -> AppResult<()> {
    let conn = connect(&app)?;
    upsert_source_tx(&conn, &source)
}

#[tauri::command]
fn upsert_media(app: AppHandle, items: Vec<MediaItem>) -> AppResult<usize> {
    let mut conn = connect(&app)?;
    upsert_media_tx(&mut conn, &items)
}

#[tauri::command]
fn list_media(app: AppHandle, query: CatalogQuery) -> AppResult<Vec<MediaItem>> {
    let conn = connect(&app)?;
    let mut where_sql = vec![
        "a.deleted_at IS NULL".to_string(),
        "EXISTS (SELECT 1 FROM media_locations l WHERE l.content_hash = a.content_hash AND l.deleted_at IS NULL)".to_string(),
    ];
    let mut bind = Vec::<Value>::new();

    if query.kind.as_deref() == Some("media") {
        where_sql.push("a.kind IN ('image', 'video')".to_string());
    } else if let Some(kind) = query.kind.as_ref().filter(|kind| *kind != "all") {
        where_sql.push("a.kind = ?".to_string());
        bind.push(Value::Text(kind.clone()));
    }
    if let Some(source_id) = query.source_id.as_ref() {
        where_sql.push(
            "EXISTS (SELECT 1 FROM media_locations ls WHERE ls.content_hash = a.content_hash AND ls.deleted_at IS NULL AND ls.source_id = ?)".to_string(),
        );
        bind.push(Value::Text(source_id.clone()));
    }
    if let Some(has_geo) = query.has_geo {
        where_sql.push(if has_geo {
            "a.latitude IS NOT NULL AND a.longitude IS NOT NULL".to_string()
        } else {
            "(a.latitude IS NULL OR a.longitude IS NULL)".to_string()
        });
    }
    if let Some(bounds) = query.geo_bounds.as_ref() {
        where_sql.push("a.latitude BETWEEN ? AND ?".to_string());
        bind.push(Value::Real(bounds.min_lat));
        bind.push(Value::Real(bounds.max_lat));
        where_sql.push("a.longitude BETWEEN ? AND ?".to_string());
        bind.push(Value::Real(bounds.min_lon));
        bind.push(Value::Real(bounds.max_lon));
    }
    if let Some(start_time) = query.start_time {
        where_sql.push("a.captured_at >= ?".to_string());
        bind.push(Value::Integer(start_time));
    }
    if let Some(end_time) = query.end_time {
        where_sql.push("a.captured_at <= ?".to_string());
        bind.push(Value::Integer(end_time));
    }

    let order = if query.sort == "captured_at_asc" {
        "CASE WHEN a.captured_at IS NULL THEN 1 ELSE 0 END, a.captured_at ASC, a.content_hash ASC"
    } else {
        "CASE WHEN a.captured_at IS NULL THEN 1 ELSE 0 END, a.captured_at DESC, a.content_hash ASC"
    };
    let limit = query.limit.unwrap_or(500).clamp(1, 10_000);
    let offset = query.offset.unwrap_or(0).max(0);
    bind.push(Value::Integer(limit));
    bind.push(Value::Integer(offset));

    let sql = format!(
        "
        SELECT a.*
        FROM media_assets a
        WHERE {}
        ORDER BY {order}
        LIMIT ? OFFSET ?
        ",
        where_sql.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(bind.iter()), asset_from_row)
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }

    attach_locations(&conn, items, query.source_id.as_deref())
}

#[tauri::command]
fn get_media_by_ids(app: AppHandle, ids: Vec<String>) -> AppResult<Vec<MediaItem>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let conn = connect(&app)?;
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT * FROM media_assets WHERE content_hash IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), asset_from_row)
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    let by_id = attach_locations(&conn, items, None)?
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<std::collections::HashMap<_, _>>();
    Ok(ids
        .into_iter()
        .filter_map(|id| by_id.get(&id).cloned())
        .collect())
}

#[tauri::command]
fn get_geo_points(app: AppHandle, range: TimeRange) -> AppResult<Vec<GeoIndexPoint>> {
    let conn = connect(&app)?;
    let mut where_sql = vec![
        "a.deleted_at IS NULL".to_string(),
        "a.latitude IS NOT NULL".to_string(),
        "a.longitude IS NOT NULL".to_string(),
        "EXISTS (SELECT 1 FROM media_locations l WHERE l.content_hash = a.content_hash AND l.deleted_at IS NULL)".to_string(),
    ];
    let mut bind = Vec::<Value>::new();

    if let Some(start_time) = range.start_time {
        where_sql.push("a.captured_at >= ?".to_string());
        bind.push(Value::Integer(start_time));
    }
    if let Some(end_time) = range.end_time {
        where_sql.push("a.captured_at <= ?".to_string());
        bind.push(Value::Integer(end_time));
    }

    let sql = format!(
        "
        SELECT a.content_hash, a.kind, a.latitude, a.longitude, a.captured_at
        FROM media_assets a
        WHERE {}
        ORDER BY a.content_hash ASC
        ",
        where_sql.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(bind.iter()), |row| {
            Ok(GeoIndexPoint {
                media_id: row.get("content_hash")?,
                kind: row.get("kind")?,
                lat: row.get("latitude")?,
                lon: row.get("longitude")?,
                captured_at: row.get("captured_at")?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut points = Vec::new();
    for row in rows {
        points.push(row.map_err(|error| error.to_string())?);
    }
    Ok(points)
}

fn emit_geo_index_progress(window: &Window, progress: GeoIndexBuildProgress) {
    let _ = window.emit("geo-index-progress", progress);
}

#[tauri::command]
fn build_geo_indexes(app: AppHandle, window: Window) -> AppResult<GeoIndexBuildSummary> {
    let started = Instant::now();
    let points = get_geo_points(
        app,
        TimeRange {
            start_time: None,
            end_time: None,
        },
    )?;
    let total_indexes = 2_usize;

    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "loading".to_string(),
            point_count: 0,
            built_indexes: 0,
            total_indexes,
            current_index_id: None,
            current_index_label: None,
            current_index_processed_points: None,
            current_index_total_points: None,
        },
    );

    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;

    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "building".to_string(),
            point_count: points.len(),
            built_indexes: 0,
            total_indexes,
            current_index_id: Some("brute-force".to_string()),
            current_index_label: Some("Brute force oracle".to_string()),
            current_index_processed_points: Some(0),
            current_index_total_points: Some(points.len()),
        },
    );
    registry.brute_force.build(&points);
    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "building".to_string(),
            point_count: points.len(),
            built_indexes: 1,
            total_indexes,
            current_index_id: Some("brute-force".to_string()),
            current_index_label: Some("Brute force oracle".to_string()),
            current_index_processed_points: Some(points.len()),
            current_index_total_points: Some(points.len()),
        },
    );

    registry
        .dynamic_z_order
        .build(&points, |processed_points| {
            emit_geo_index_progress(
                &window,
                GeoIndexBuildProgress {
                    phase: "building".to_string(),
                    point_count: points.len(),
                    built_indexes: 1,
                    total_indexes,
                    current_index_id: Some("dynamic-z-order-cells".to_string()),
                    current_index_label: Some("Dynamic Z-order cells".to_string()),
                    current_index_processed_points: Some(processed_points),
                    current_index_total_points: Some(points.len()),
                },
            );
            Ok(())
        })?;
    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "ready".to_string(),
            point_count: points.len(),
            built_indexes: total_indexes,
            total_indexes,
            current_index_id: None,
            current_index_label: None,
            current_index_processed_points: None,
            current_index_total_points: None,
        },
    );

    Ok(GeoIndexBuildSummary {
        point_count: points.len(),
        build_time_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

#[tauri::command]
fn search_geo_index(index_id: String, query: GeoSearchQuery) -> AppResult<Vec<GeoSearchResult>> {
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let results = if index_id == "dynamic-z-order-cells" {
        registry.dynamic_z_order.search(&query)
    } else {
        registry.brute_force.search(&query)
    };
    Ok(results)
}

#[tauri::command]
fn get_geo_index_stats(index_id: String) -> AppResult<GeoIndexStats> {
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(if index_id == "dynamic-z-order-cells" {
        registry.dynamic_z_order.last_stats.clone()
    } else {
        registry.brute_force.last_stats.clone()
    })
}

#[tauri::command]
fn validate_geo_index(index_id: String, query: GeoSearchQuery) -> AppResult<ValidationReport> {
    if index_id == "brute-force" {
        return Ok(ValidationReport {
            checked: true,
            equal: true,
            compared_with: "brute-force".to_string(),
            message: "Brute force is the comparison baseline.".to_string(),
        });
    }

    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let actual = registry.dynamic_z_order.search(&query);
    let expected = registry.brute_force.search(&query);
    let equal = actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected.iter())
            .all(|(actual, expected)| {
                actual.media_id == expected.media_id
                    && (actual.distance_meters - expected.distance_meters).abs()
                        < DISTANCE_TIE_EPSILON_METERS
            });

    Ok(ValidationReport {
        checked: true,
        equal,
        compared_with: "brute-force".to_string(),
        message: if equal {
            "Result order matches brute force.".to_string()
        } else {
            "Result order differs from brute force.".to_string()
        },
    })
}

#[tauri::command]
fn list_sources(app: AppHandle) -> AppResult<Vec<MediaSource>> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, label, added_at FROM media_sources ORDER BY added_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MediaSource {
                id: row.get("id")?,
                label: row.get("label")?,
                added_at: row.get("added_at")?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut sources = Vec::new();
    for row in rows {
        sources.push(row.map_err(|error| error.to_string())?);
    }
    Ok(sources)
}

#[tauri::command]
fn remove_sources(app: AppHandle, source_ids: Vec<String>) -> AppResult<()> {
    if source_ids.is_empty() {
        return Ok(());
    }
    let conn = connect(&app)?;
    let placeholders = source_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!("DELETE FROM media_locations WHERE source_id IN ({placeholders})"),
        params_from_iter(source_ids.iter()),
    )
    .map_err(|error| error.to_string())?;
    conn.execute_batch(
        "
        DELETE FROM media_assets
        WHERE NOT EXISTS (
          SELECT 1 FROM media_locations l
          WHERE l.content_hash = media_assets.content_hash
        );
        ",
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        &format!("DELETE FROM media_sources WHERE id IN ({placeholders})"),
        params_from_iter(source_ids.iter()),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn count_media(app: AppHandle) -> AppResult<i64> {
    let conn = connect(&app)?;
    conn.query_row(
        "
        SELECT COUNT(*)
        FROM media_assets a
        WHERE a.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM media_locations l
            WHERE l.content_hash = a.content_hash AND l.deleted_at IS NULL
          )
        ",
        [],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_catalog(app: AppHandle) -> AppResult<()> {
    let conn = connect(&app)?;
    conn.execute_batch(
        "
        DELETE FROM media_locations;
        DELETE FROM media_assets;
        DELETE FROM media_sources;
        ",
    )
    .map_err(|error| error.to_string())
}

fn emit_progress(window: &Window, progress: ImportProgress) {
    let _ = window.emit("import-progress", progress);
}

fn import_progress(
    phase: &str,
    source_label: &str,
    scanned_files: i64,
    total_files: i64,
    accepted_media: i64,
    skipped_files: i64,
    current_path: Option<String>,
) -> ImportProgress {
    ImportProgress {
        phase: phase.to_string(),
        source_label: source_label.to_string(),
        scanned_files,
        total_files,
        accepted_media,
        skipped_files,
        current_path,
        scanned_bytes: None,
        total_bytes: None,
    }
}

fn import_progress_bytes(
    phase: &str,
    source_label: &str,
    accepted_media: i64,
    skipped_files: i64,
    current_path: Option<String>,
    scanned_bytes: i64,
    total_bytes: i64,
) -> ImportProgress {
    ImportProgress {
        phase: phase.to_string(),
        source_label: source_label.to_string(),
        scanned_files: if scanned_bytes >= total_bytes { 1 } else { 0 },
        total_files: 1,
        accepted_media,
        skipped_files,
        current_path,
        scanned_bytes: Some(scanned_bytes),
        total_bytes: Some(total_bytes),
    }
}

fn flush_media_batch(conn: &mut Connection, batch: &mut Vec<MediaItem>) -> AppResult<usize> {
    if batch.is_empty() {
        return Ok(0);
    }
    let written = upsert_media_tx(conn, batch)?;
    batch.clear();
    Ok(written)
}

fn read_file_prefix(path: &Path) -> AppResult<String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; GEO_IMPORT_PREFIX_BYTES];
    let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
    buffer.truncate(read);
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn maybe_emit_byte_progress(
    window: &Window,
    last_progress: &mut Instant,
    source_label: &str,
    accepted_media: i64,
    skipped_files: i64,
    current_path: Option<String>,
    scanned_bytes: i64,
    total_bytes: i64,
) {
    if last_progress.elapsed().as_millis() < PROGRESS_HEARTBEAT_MS {
        return;
    }
    *last_progress = Instant::now();
    emit_progress(
        window,
        import_progress_bytes(
            "scanning",
            source_label,
            accepted_media,
            skipped_files,
            current_path,
            scanned_bytes,
            total_bytes,
        ),
    );
}

fn import_google_takeout_streaming(
    path: &Path,
    source: &MediaSource,
    absolute_path: &str,
    total_bytes: i64,
    conn: &mut Connection,
    window: &Window,
) -> AppResult<(i64, i64)> {
    let source_label = source.label.clone();
    let mut file = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let mut parser = GoogleTakeoutLocationStreamParser::new();
    let mut read_buffer = [0_u8; 256 * 1024];
    let mut batch = Vec::<MediaItem>::new();
    let mut accepted_media = 0_i64;
    let mut scanned_bytes = 0_i64;
    let mut last_progress = Instant::now() - std::time::Duration::from_millis(1000);

    loop {
        let read = file
            .read(&mut read_buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        scanned_bytes += read as i64;
        let chunk = String::from_utf8_lossy(&read_buffer[..read]);
        let points = parser.feed(&chunk)?;

        for point in points {
            batch.push(geo_point_item_from_parsed_point(
                source,
                absolute_path,
                "application/json",
                &point,
            ));
            accepted_media += 1;
            if batch.len() >= IMPORT_BATCH_SIZE {
                emit_progress(
                    window,
                    import_progress_bytes(
                        "scanning",
                        &source_label,
                        accepted_media,
                        parser.skipped_points,
                        Some(source_label.clone()),
                        scanned_bytes,
                        total_bytes,
                    ),
                );
                flush_media_batch(conn, &mut batch)?;
                emit_progress(
                    window,
                    import_progress_bytes(
                        "scanning",
                        &source_label,
                        accepted_media,
                        parser.skipped_points,
                        Some(source_label.clone()),
                        scanned_bytes,
                        total_bytes,
                    ),
                );
            }
        }

        maybe_emit_byte_progress(
            window,
            &mut last_progress,
            &source_label,
            accepted_media,
            parser.skipped_points,
            Some(source_label.clone()),
            scanned_bytes,
            total_bytes,
        );
    }

    parser.finish()?;
    emit_progress(
        window,
        import_progress_bytes(
            "storing",
            &source_label,
            accepted_media,
            parser.skipped_points,
            Some(source_label.clone()),
            total_bytes,
            total_bytes,
        ),
    );
    flush_media_batch(conn, &mut batch)?;
    Ok((accepted_media, parser.skipped_points))
}

fn import_gpx_streaming(
    path: &Path,
    source: &MediaSource,
    absolute_path: &str,
    total_bytes: i64,
    conn: &mut Connection,
    window: &Window,
) -> AppResult<(i64, i64)> {
    let source_label = source.label.clone();
    let mut batch = Vec::<MediaItem>::new();
    let mut accepted_media = 0_i64;
    let mut skipped_files = 0_i64;
    let mut last_progress = Instant::now() - std::time::Duration::from_millis(1000);

    let final_skipped = stream_gpx_points(path, |event| {
        match event {
            GpxStreamEvent::Point(point, position) => {
                batch.push(geo_point_item_from_parsed_point(
                    source,
                    absolute_path,
                    "application/gpx+xml",
                    &point,
                ));
                accepted_media += 1;
                if batch.len() >= IMPORT_BATCH_SIZE {
                    emit_progress(
                        window,
                        import_progress_bytes(
                            "scanning",
                            &source_label,
                            accepted_media,
                            skipped_files,
                            Some(source_label.clone()),
                            position as i64,
                            total_bytes,
                        ),
                    );
                    flush_media_batch(conn, &mut batch)?;
                    emit_progress(
                        window,
                        import_progress_bytes(
                            "scanning",
                            &source_label,
                            accepted_media,
                            skipped_files,
                            Some(source_label.clone()),
                            position as i64,
                            total_bytes,
                        ),
                    );
                }
                maybe_emit_byte_progress(
                    window,
                    &mut last_progress,
                    &source_label,
                    accepted_media,
                    skipped_files,
                    Some(source_label.clone()),
                    position as i64,
                    total_bytes,
                );
            }
            GpxStreamEvent::Skipped(count, position) => {
                skipped_files = count;
                maybe_emit_byte_progress(
                    window,
                    &mut last_progress,
                    &source_label,
                    accepted_media,
                    skipped_files,
                    Some(source_label.clone()),
                    position as i64,
                    total_bytes,
                );
            }
        }
        Ok(())
    })?;

    skipped_files = final_skipped;
    emit_progress(
        window,
        import_progress_bytes(
            "storing",
            &source_label,
            accepted_media,
            skipped_files,
            Some(source_label.clone()),
            total_bytes,
            total_bytes,
        ),
    );
    flush_media_batch(conn, &mut batch)?;
    Ok((accepted_media, skipped_files))
}

#[tauri::command]
fn import_folder(app: AppHandle, window: Window) -> AppResult<ImportSummary> {
    let Some(root) = rfd::FileDialog::new().pick_folder() else {
        return Err("Import cancelled".to_string());
    };
    let root = root.canonicalize().unwrap_or(root);
    let source = source_from_root(&root);
    let source_label = source.label.clone();

    let mut total_files = 0_i64;
    for entry in WalkDir::new(&root).follow_links(false).into_iter() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.file_type().is_file() {
            total_files += 1;
            if total_files % 200 == 0 {
                emit_progress(
                    &window,
                    import_progress("counting", &source_label, 0, total_files, 0, 0, None),
                );
            }
        }
    }

    let mut conn = connect(&app)?;
    upsert_source_tx(&conn, &source)?;

    let mut batch = Vec::<MediaItem>::new();
    let mut errors = Vec::<String>::new();
    let mut scanned_files = 0_i64;
    let mut accepted_media = 0_i64;
    let mut skipped_files = 0_i64;

    emit_progress(
        &window,
        import_progress(
            "scanning",
            &source_label,
            scanned_files,
            total_files,
            accepted_media,
            skipped_files,
            None,
        ),
    );

    for entry in WalkDir::new(&root).follow_links(false).into_iter() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }

        scanned_files += 1;
        let path = entry.path().to_path_buf();
        let current_path = relative_path(&root, &path);

        match media_from_path(&app, &source.id, &root, &path) {
            Ok(Some(item)) => {
                batch.push(item);
                accepted_media += 1;
                if batch.len() >= IMPORT_BATCH_SIZE {
                    emit_progress(
                        &window,
                        import_progress(
                            "scanning",
                            &source_label,
                            scanned_files,
                            total_files,
                            accepted_media,
                            skipped_files,
                            Some(current_path.clone()),
                        ),
                    );
                    flush_media_batch(&mut conn, &mut batch)?;
                    emit_progress(
                        &window,
                        import_progress(
                            "scanning",
                            &source_label,
                            scanned_files,
                            total_files,
                            accepted_media,
                            skipped_files,
                            Some(current_path.clone()),
                        ),
                    );
                }
            }
            Ok(None) => {
                skipped_files += 1;
            }
            Err(error) => {
                skipped_files += 1;
                errors.push(format!("{current_path}: {error}"));
            }
        }

        if scanned_files % 20 == 0 {
            emit_progress(
                &window,
                import_progress(
                    "scanning",
                    &source_label,
                    scanned_files,
                    total_files,
                    accepted_media,
                    skipped_files,
                    Some(current_path),
                ),
            );
        }
    }

    emit_progress(
        &window,
        import_progress(
            "storing",
            &source_label,
            scanned_files,
            total_files,
            accepted_media,
            skipped_files,
            None,
        ),
    );
    flush_media_batch(&mut conn, &mut batch)?;

    Ok(ImportSummary {
        source,
        source_label,
        scanned_files,
        total_files,
        accepted_media,
        skipped_files,
        errors,
    })
}

#[tauri::command]
fn import_geo_file(app: AppHandle, window: Window) -> AppResult<ImportSummary> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Geo point files", &["gpx", "json", "geojson"])
        .pick_file()
    else {
        return Err("Import cancelled".to_string());
    };
    let path = path.canonicalize().unwrap_or(path);
    let absolute_path = path.to_string_lossy().to_string();
    let source = source_from_file(&path);
    let source_label = source.label.clone();

    emit_progress(
        &window,
        import_progress_bytes(
            "counting",
            &source_label,
            0,
            0,
            Some(source_label.clone()),
            0,
            fs::metadata(&path)
                .map(|metadata| metadata.len() as i64)
                .unwrap_or(0),
        ),
    );

    let total_bytes = fs::metadata(&path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    let prefix = read_file_prefix(&path)?;
    let format = detect_geo_file_format_from_prefix(&path, &prefix)?;
    let mut conn = connect(&app)?;
    upsert_source_tx(&conn, &source)?;
    let (accepted_media, skipped_files) = match format {
        GeoFileFormat::GoogleTakeoutJson => import_google_takeout_streaming(
            &path,
            &source,
            &absolute_path,
            total_bytes,
            &mut conn,
            &window,
        )?,
        GeoFileFormat::Gpx => import_gpx_streaming(
            &path,
            &source,
            &absolute_path,
            total_bytes,
            &mut conn,
            &window,
        )?,
    };

    Ok(ImportSummary {
        source,
        source_label,
        scanned_files: 1,
        total_files: 1,
        accepted_media,
        skipped_files,
        errors: Vec::new(),
    })
}

#[tauri::command]
fn resolve_thumbnail_path(app: AppHandle, thumbnail_key: String) -> AppResult<Option<String>> {
    let file_name = Path::new(&thumbnail_key)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid thumbnail key".to_string())?;
    let path = app_cache_dir(&app)?.join("thumbs").join(file_name);
    Ok(path.exists().then(|| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn reveal_location(location: MediaLocation) -> AppResult<()> {
    let path = location
        .absolute_path
        .ok_or_else(|| "No absolute path is stored for this location.".to_string())?;
    opener::reveal(path).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            init_catalog,
            upsert_source,
            upsert_media,
            list_media,
            get_media_by_ids,
            get_geo_points,
            build_geo_indexes,
            search_geo_index,
            get_geo_index_stats,
            validate_geo_index,
            list_sources,
            remove_sources,
            count_media,
            clear_catalog,
            import_folder,
            import_geo_file,
            resolve_thumbnail_path,
            reveal_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_item(content_hash: &str, source_id: &str, path: &str) -> MediaItem {
        let location_id = sha256_string(&format!("{source_id}\n{path}"));
        MediaItem {
            id: content_hash.to_string(),
            content_hash: content_hash.to_string(),
            source_id: source_id.to_string(),
            relative_path: path.to_string(),
            display_name: display_name(Path::new(path)),
            kind: "image".to_string(),
            mime_type: "image/jpeg".to_string(),
            size_bytes: 12,
            width: Some(3),
            height: Some(4),
            duration_ms: None,
            captured_at: Some(1_700_000_000_000),
            captured_at_source: Some("filesystem".to_string()),
            latitude: Some(47.0),
            longitude: Some(8.0),
            geo_source: Some("manual".to_string()),
            thumbnail_key: Some(format!("thumbs/{content_hash}.webp")),
            deleted_at: None,
            last_seen_at: now_ms(),
            locations: vec![MediaLocation {
                id: location_id,
                source_id: source_id.to_string(),
                relative_path: Some(path.to_string()),
                absolute_path: Some(path.to_string()),
                display_name: display_name(Path::new(path)),
                deleted_at: None,
                last_seen_at: now_ms(),
            }],
        }
    }

    #[test]
    fn hashes_strings_as_sha256_hex() {
        assert_eq!(
            sha256_string("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn detects_supported_media_extensions() {
        assert_eq!(detect_media_kind(Path::new("a.JPG")), Some("image"));
        assert_eq!(detect_media_kind(Path::new("clip.mp4")), Some("video"));
        assert_eq!(detect_media_kind(Path::new("notes.txt")), None);
        assert_eq!(detect_media_kind(Path::new("track.gpx")), None);
    }

    #[test]
    fn normalizes_geo_point_identity_with_9_decimals() {
        assert_eq!(
            geo_point_identity_input(48.1234567894, 11.9876543214, 1_782_036_930_123),
            "geo_point:v1\n48.123456789\n11.987654321\n1782036930123"
        );
        assert_eq!(
            geo_point_content_hash(48.1234567894, 11.9876543214, 1_782_036_930_123).len(),
            64
        );
    }

    #[test]
    fn parses_timed_gpx_points_and_skips_invalid_entries() {
        let parsed = parse_gpx_points(
            r#"
            <gpx>
              <trk><trkseg>
                <trkpt lat="48.1" lon="11.5"><time>2026-06-21T10:00:00Z</time></trkpt>
                <trkpt lat="91" lon="11.5"><time>2026-06-21T10:01:00Z</time></trkpt>
                <trkpt lat="48.2" lon="11.6"></trkpt>
              </trkseg></trk>
              <rte><rtept lat="48.3" lon="11.7"><time>2026-06-21T10:02:00Z</time></rtept></rte>
              <wpt lat="48.4" lon="11.8"><time>2026-06-21T10:03:00Z</time></wpt>
            </gpx>
            "#,
        )
        .unwrap();

        assert_eq!(parsed.skipped_points, 2);
        assert_eq!(parsed.mime_type, "application/gpx+xml");
        assert_eq!(parsed.points.len(), 3);
        assert_eq!(parsed.points[0].index, 1);
        assert_eq!(parsed.points[1].index, 4);
        assert_eq!(parsed.points[2].index, 5);
    }

    #[test]
    fn parses_google_takeout_location_json_points() {
        let parsed = parse_google_takeout_location_points(
            r#"
            {
              "locations": [{
                "latitudeE7": 481370673,
                "longitudeE7": 115775995,
                "accuracy": 540,
                "source": "CELL",
                "timestamp": "2012-10-28T14:21:22.010Z"
              }, {
                "latitudeE7": 481374628,
                "longitudeE7": 115781587,
                "accuracy": 22,
                "activity": [{
                  "activity": [{
                    "type": "STILL",
                    "confidence": 100
                  }],
                  "timestamp": "2012-10-28T14:21:46.568Z"
                }],
                "source": "CELL",
                "timestamp": "2012-10-28T14:22:24.784Z"
              }, {
                "latitudeE7": 481374628,
                "longitudeE7": 115781587
              }, {
                "latitudeE7": "481374628",
                "longitudeE7": "115781587",
                "timestampMs": "1351434205077"
              }, {
                "latitudeE7": "481374629",
                "longitudeE7": "115781588",
                "timestampMS": "1351434206077"
              }]
            }
            "#,
        )
        .unwrap();

        assert_eq!(parsed.mime_type, "application/json");
        assert_eq!(parsed.skipped_points, 1);
        assert_eq!(parsed.points.len(), 4);
        assert_eq!(parsed.points[0].index, 1);
        assert_eq!(parsed.points[0].latitude, 48.1370673);
        assert_eq!(parsed.points[0].longitude, 11.5775995);
        assert_eq!(
            parsed.points[0].captured_at,
            DateTime::parse_from_rfc3339("2012-10-28T14:21:22.010Z")
                .unwrap()
                .timestamp_millis()
        );
        assert_eq!(parsed.points[2].index, 4);
        assert_eq!(parsed.points[2].captured_at, 1_351_434_205_077);
        assert_eq!(parsed.points[3].index, 5);
        assert_eq!(parsed.points[3].captured_at, 1_351_434_206_077);
    }

    #[test]
    fn detects_geo_file_format_from_content() {
        assert_eq!(
            detect_geo_file_format(
                Path::new("track.json"),
                r#"
                <gpx>
                  <wpt lat="48.4" lon="11.8"><time>2026-06-21T10:03:00Z</time></wpt>
                </gpx>
                "#
            )
            .unwrap(),
            GeoFileFormat::Gpx
        );

        assert_eq!(
            detect_geo_file_format(
                Path::new("records.gpx"),
                r#"
                {
                  "locations": [{
                    "latitudeE7": 481370673,
                    "longitudeE7": 115775995,
                    "timestamp": "2012-10-28T14:21:22.010Z"
                  }]
                }
                "#
            )
            .unwrap(),
            GeoFileFormat::GoogleTakeoutJson
        );
    }

    #[test]
    fn parses_geo_files_by_detected_content_not_extension() {
        let google_json = r#"
            {
              "locations": [{
                "latitudeE7": 481370673,
                "longitudeE7": 115775995,
                "timestamp": "2012-10-28T14:21:22.010Z"
              }]
            }
        "#;
        let gpx = r#"
            <gpx>
              <wpt lat="48.4" lon="11.8"><time>2026-06-21T10:03:00Z</time></wpt>
            </gpx>
        "#;

        let json_result = parse_geo_file_points(Path::new("records.gpx"), google_json).unwrap();
        let gpx_result = parse_geo_file_points(Path::new("track.json"), gpx).unwrap();

        assert_eq!(json_result.mime_type, "application/json");
        assert_eq!(json_result.points.len(), 1);
        assert_eq!(gpx_result.mime_type, "application/gpx+xml");
        assert_eq!(gpx_result.points.len(), 1);
    }

    #[test]
    fn rejects_unsupported_geo_json_formats() {
        let geojson_error = parse_geo_file_points(
            Path::new("places.geojson"),
            r#"{ "type": "FeatureCollection", "features": [] }"#,
        )
        .unwrap_err();
        let unknown_json_error =
            parse_geo_file_points(Path::new("unknown.json"), r#"{ "items": [] }"#).unwrap_err();
        let unknown_text_error =
            parse_geo_file_points(Path::new("notes.txt"), "plain text").unwrap_err();

        assert!(geojson_error.contains("GeoJSON files are not supported yet"));
        assert!(unknown_json_error.contains("not a supported geo import format"));
        assert!(unknown_text_error.contains("not a supported geo import format"));
    }

    #[test]
    fn identifies_semantic_location_history_as_valid_but_unsupported() {
        let error = parse_geo_file_points(
            Path::new("2024_JANUARY.json"),
            r#"{ "timelineObjects": [{ "placeVisit": {} }] }"#,
        )
        .unwrap_err();

        assert!(error.contains("Google Semantic Location History"));
    }

    #[test]
    fn upsert_allows_many_geo_points_from_one_source_path() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        let source = MediaSource {
            id: "gpx-source".to_string(),
            label: "track.gpx".to_string(),
            added_at: now_ms(),
        };
        let first = ParsedGeoPoint {
            index: 1,
            latitude: 48.1,
            longitude: 11.5,
            captured_at: 1_782_036_000_000,
        };
        let second = ParsedGeoPoint {
            index: 2,
            latitude: 48.2,
            longitude: 11.6,
            captured_at: 1_782_036_060_000,
        };
        let items = vec![
            geo_point_item_from_parsed_point(
                &source,
                "/tmp/track.gpx",
                "application/gpx+xml",
                &first,
            ),
            geo_point_item_from_parsed_point(
                &source,
                "/tmp/track.gpx",
                "application/gpx+xml",
                &second,
            ),
        ];

        upsert_source_tx(&conn, &source).unwrap();
        upsert_media_tx(&mut conn, &items).unwrap();
        upsert_media_tx(&mut conn, &items).unwrap();

        let asset_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_assets", [], |row| row.get(0))
            .unwrap();
        let location_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_locations", [], |row| row.get(0))
            .unwrap();

        assert_eq!(asset_count, 2);
        assert_eq!(location_count, 2);
    }

    #[test]
    fn migrates_location_schema_to_remove_source_path_uniqueness() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE media_locations (
              id TEXT PRIMARY KEY,
              content_hash TEXT NOT NULL,
              source_id TEXT NOT NULL,
              relative_path TEXT,
              absolute_path TEXT NOT NULL,
              display_name TEXT NOT NULL,
              deleted_at INTEGER,
              last_seen_at INTEGER NOT NULL,
              UNIQUE(source_id, absolute_path)
            );
            ",
        )
        .unwrap();

        ensure_schema(&conn).unwrap();

        let table_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_locations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!table_sql.contains("UNIQUE(source_id, absolute_path)"));
    }

    #[test]
    fn upsert_keeps_one_asset_with_many_locations() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        let source = MediaSource {
            id: "source".to_string(),
            label: "Source".to_string(),
            added_at: now_ms(),
        };
        upsert_source_tx(&conn, &source).unwrap();

        let first = test_item("same-hash", "source", "a/photo.jpg");
        let second = test_item("same-hash", "source", "b/photo-copy.jpg");
        upsert_media_tx(&mut conn, &[first.clone(), second]).unwrap();
        upsert_media_tx(&mut conn, &[first]).unwrap();

        let asset_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_assets", [], |row| row.get(0))
            .unwrap();
        let location_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_locations", [], |row| row.get(0))
            .unwrap();

        assert_eq!(asset_count, 1);
        assert_eq!(location_count, 2);
    }
}
