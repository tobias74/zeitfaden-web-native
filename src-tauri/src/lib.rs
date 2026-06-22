use chrono::{DateTime, NaiveDateTime};
use exif::{In, Reader as ExifReader, Tag, Value as ExifValue};
use image::ImageFormat;
use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader as XmlReader;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Window};
use walkdir::WalkDir;

type AppResult<T> = Result<T, String>;

const IMPORT_BATCH_SIZE: usize = 1000;
const SQLITE_BIND_CHUNK_LIMIT: usize = 12000;
const ASSET_BIND_COLUMNS: usize = 9;
const LOCATION_BIND_COLUMNS: usize = 7;
const GEO_IMPORT_PREFIX_BYTES: usize = 512 * 1024;
const PROGRESS_HEARTBEAT_MS: u128 = 1000;
const CATALOG_EPOCH_KEY: &str = "catalogEpoch";
const DYNAMIC_INDEX_MAGIC: &[u8; 8] = b"ZFDZIDX1";
const DYNAMIC_INDEX_FORMAT_VERSION: u32 = 1;
const SEGMENTED_KD_TREE_SEGMENT_LIMIT: usize = 100_000;
const SEGMENTED_KD_TREE_DELTA_LIMIT: usize = 50_000;
const SEGMENTED_KD_TREE_LEAF_SIZE: usize = 64;
const SEGMENTED_BALL_TREE_SEGMENT_LIMIT: usize = 100_000;
const SEGMENTED_BALL_TREE_DELTA_LIMIT: usize = 50_000;
const SEGMENTED_BALL_TREE_LEAF_SIZE: usize = 64;
static IMPORT_CANCELLED: AtomicBool = AtomicBool::new(false);
static IMPORT_COMMIT_REQUESTED: AtomicBool = AtomicBool::new(false);

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
    root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaLocation {
    id: String,
    source_id: String,
    source_label: String,
    root_path: Option<String>,
    relative_path: Option<String>,
    absolute_path: Option<String>,
    point_index: Option<i64>,
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
    duration_ms: Option<i64>,
    timestamp: Option<i64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    thumbnail_key: Option<String>,
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
    timestamp: Option<i64>,
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
    resident_bytes: Option<usize>,
    disk_read_bytes: Option<usize>,
    disk_read_count: Option<usize>,
    page_cache_hits: Option<usize>,
    page_cache_misses: Option<usize>,
    loaded_pages: Option<usize>,
    index_storage: Option<String>,
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
    segment_count: Option<usize>,
    delta_segment_count: Option<usize>,
    loaded_segments: Option<usize>,
    max_leaf_size: Option<usize>,
    pending_point_count: Option<usize>,
    needs_optimization: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchPoint {
    lat: f64,
    lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchOrder {
    kind: String,
    sort: Option<String>,
    point: Option<SearchPoint>,
    engine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchDiagnostics {
    explain_sql: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchSpec {
    kind: Option<String>,
    source_id: Option<String>,
    has_geo: Option<bool>,
    geo_bounds: Option<GeoBounds>,
    order: SearchOrder,
    limit: Option<i64>,
    offset: Option<i64>,
    purpose: String,
    start_time: Option<i64>,
    end_time: Option<i64>,
    diagnostics: Option<SearchDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlExplainPlanRow {
    id: i64,
    parent: i64,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlExplainPlan {
    rows: Vec<SqlExplainPlanRow>,
    used_indexes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchIndexStats {
    engine_id: String,
    engine_label: Option<String>,
    exact: Option<bool>,
    persistent: Option<bool>,
    point_count: usize,
    index_size_bytes: Option<usize>,
    resident_bytes: Option<usize>,
    disk_read_bytes: Option<usize>,
    disk_read_count: Option<usize>,
    page_cache_hits: Option<usize>,
    page_cache_misses: Option<usize>,
    loaded_pages: Option<usize>,
    index_storage: Option<String>,
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
    segment_count: Option<usize>,
    delta_segment_count: Option<usize>,
    loaded_segments: Option<usize>,
    max_leaf_size: Option<usize>,
    pending_point_count: Option<usize>,
    needs_optimization: Option<bool>,
    query_purpose: Option<String>,
    storage_mode: Option<String>,
    query_time_ms: Option<f64>,
    rows_returned: Option<usize>,
    limit: Option<i64>,
    offset: Option<i64>,
    limit_reached: Option<bool>,
    sql_plan: Option<SqlExplainPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultRow {
    media_id: String,
    distance_meters: Option<f64>,
    item: MediaItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchPage {
    items: Vec<SearchResultRow>,
    result_metrics: SearchIndexStats,
    engine_id: String,
    engine_label: String,
    limit_reached: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchIndexBuildSummary {
    point_count: usize,
    build_time_ms: f64,
    engine_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicIndexManifest {
    engine_id: String,
    engine_version: u32,
    resolution: u32,
    catalog_epoch: i64,
    point_count: usize,
    cell_count: usize,
    created_at: i64,
    data_checksum: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedGeoPoint {
    index: i64,
    latitude: f64,
    longitude: f64,
    timestamp: i64,
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
    timestamp: Option<i64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Clone)]
struct NativeCell {
    z: u32,
    lat_min: f64,
    lat_max: f64,
    min_timestamp: Option<i64>,
    max_timestamp: Option<i64>,
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

#[derive(Clone, Serialize, Deserialize)]
struct NativeKdSegment {
    id: String,
    is_delta: bool,
    points: Vec<GeoIndexPoint>,
    max_leaf_size: usize,
}

#[derive(Clone)]
struct NativeSegmentedKdTreeIndex {
    segments: Vec<NativeKdSegment>,
    pending_points: Vec<GeoIndexPoint>,
    disk_manifest: Option<NativeDiskSegmentedManifest>,
    disk_dir: Option<PathBuf>,
    segment_cache: VecDeque<(String, NativeKdSegment)>,
    last_stats: GeoIndexStats,
}

#[derive(Clone, Serialize, Deserialize)]
struct NativeBallNode {
    left: Option<usize>,
    right: Option<usize>,
    point_start: usize,
    point_end: usize,
    center_lat: f64,
    center_lon: f64,
    radius_meters: f64,
    lat_min: f64,
    lat_max: f64,
    lon_min: f64,
    lon_max: f64,
    min_timestamp: Option<i64>,
    max_timestamp: Option<i64>,
    kind_mask: u8,
}

#[derive(Clone, Serialize, Deserialize)]
struct NativeBallSegment {
    id: String,
    is_delta: bool,
    nodes: Vec<NativeBallNode>,
    points: Vec<GeoIndexPoint>,
    point_count: usize,
    max_leaf_size: usize,
}

#[derive(Clone)]
struct NativeSegmentedBallTreeIndex {
    segments: Vec<NativeBallSegment>,
    pending_points: Vec<GeoIndexPoint>,
    disk_manifest: Option<NativeDiskSegmentedManifest>,
    disk_dir: Option<PathBuf>,
    segment_cache: VecDeque<(String, NativeBallSegment)>,
    last_stats: GeoIndexStats,
}

#[derive(Serialize, Deserialize)]
struct NativeSegmentedKdTreeSnapshot {
    engine_id: String,
    engine_version: u32,
    segment_point_limit: usize,
    delta_flush_point_limit: usize,
    leaf_size: usize,
    point_count: usize,
    segment_count: usize,
    segments: Vec<NativeKdSegment>,
    pending_points: Vec<GeoIndexPoint>,
}

#[derive(Serialize, Deserialize)]
struct NativeSegmentedBallTreeSnapshot {
    engine_id: String,
    engine_version: u32,
    segment_point_limit: usize,
    delta_flush_point_limit: usize,
    leaf_size: usize,
    point_count: usize,
    segment_count: usize,
    segments: Vec<NativeBallSegment>,
    pending_points: Vec<GeoIndexPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentedKdTreeManifest {
    engine_id: String,
    engine_version: u32,
    catalog_epoch: i64,
    point_count: usize,
    segment_count: usize,
    created_at: i64,
    data_checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentedBallTreeManifest {
    engine_id: String,
    engine_version: u32,
    catalog_epoch: i64,
    point_count: usize,
    segment_count: usize,
    created_at: i64,
    data_checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSegmentSummary {
    lat_min: f64,
    lat_max: f64,
    lon_min: f64,
    lon_max: f64,
    min_timestamp: Option<i64>,
    max_timestamp: Option<i64>,
    kind_mask: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiskSegmentRef {
    id: String,
    is_delta: bool,
    point_count: usize,
    max_leaf_size: usize,
    byte_len: usize,
    summary: NativeSegmentSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiskSegmentedManifest {
    engine_id: String,
    engine_version: u32,
    catalog_epoch: i64,
    point_count: usize,
    segment_count: usize,
    created_at: i64,
    segments: Vec<NativeDiskSegmentRef>,
}

#[derive(Clone)]
struct NativeGeoIndexRegistry {
    brute_force: NativeBruteForceIndex,
    dynamic_z_order: NativeDynamicZOrderIndex,
    segmented_kd_tree: NativeSegmentedKdTreeIndex,
    segmented_ball_tree: NativeSegmentedBallTreeIndex,
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
            segmented_kd_tree: NativeSegmentedKdTreeIndex::default(),
            segmented_ball_tree: NativeSegmentedBallTreeIndex::default(),
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

impl Default for NativeSegmentedKdTreeIndex {
    fn default() -> Self {
        Self {
            segments: Vec::new(),
            pending_points: Vec::new(),
            disk_manifest: None,
            disk_dir: None,
            segment_cache: VecDeque::new(),
            last_stats: empty_geo_index_stats("segmented-kd-tree", 0),
        }
    }
}

impl Default for NativeSegmentedBallTreeIndex {
    fn default() -> Self {
        Self {
            segments: Vec::new(),
            pending_points: Vec::new(),
            disk_manifest: None,
            disk_dir: None,
            segment_cache: VecDeque::new(),
            last_stats: empty_geo_index_stats("segmented-ball-tree", 0),
        }
    }
}

fn empty_geo_index_stats(engine_id: &str, point_count: usize) -> GeoIndexStats {
    GeoIndexStats {
        engine_id: engine_id.to_string(),
        point_count,
        index_size_bytes: None,
        resident_bytes: None,
        disk_read_bytes: None,
        disk_read_count: None,
        page_cache_hits: None,
        page_cache_misses: None,
        loaded_pages: None,
        index_storage: None,
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
        segment_count: None,
        delta_segment_count: None,
        loaded_segments: None,
        max_leaf_size: None,
        pending_point_count: None,
        needs_optimization: None,
    }
}

fn empty_search_index_stats(engine_id: &str, engine_label: &str) -> SearchIndexStats {
    SearchIndexStats {
        engine_id: engine_id.to_string(),
        engine_label: Some(engine_label.to_string()),
        exact: Some(true),
        persistent: Some(true),
        point_count: 0,
        index_size_bytes: None,
        resident_bytes: None,
        disk_read_bytes: None,
        disk_read_count: None,
        page_cache_hits: None,
        page_cache_misses: None,
        loaded_pages: None,
        index_storage: None,
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
        segment_count: None,
        delta_segment_count: None,
        loaded_segments: None,
        max_leaf_size: None,
        pending_point_count: None,
        needs_optimization: None,
        query_purpose: None,
        storage_mode: None,
        query_time_ms: None,
        rows_returned: None,
        limit: None,
        offset: None,
        limit_reached: None,
        sql_plan: None,
    }
}

fn search_stats_from_geo(
    stats: GeoIndexStats,
    engine_label: &str,
    exact: bool,
    persistent: bool,
) -> SearchIndexStats {
    SearchIndexStats {
        engine_id: stats.engine_id,
        engine_label: Some(engine_label.to_string()),
        exact: Some(exact),
        persistent: Some(persistent),
        point_count: stats.point_count,
        index_size_bytes: stats.index_size_bytes,
        resident_bytes: stats.resident_bytes,
        disk_read_bytes: stats.disk_read_bytes,
        disk_read_count: stats.disk_read_count,
        page_cache_hits: stats.page_cache_hits,
        page_cache_misses: stats.page_cache_misses,
        loaded_pages: stats.loaded_pages,
        index_storage: stats.index_storage,
        build_time_ms: stats.build_time_ms,
        insert_time_ms: stats.insert_time_ms,
        delete_time_ms: stats.delete_time_ms,
        last_query_time_ms: stats.last_query_time_ms,
        distance_computations: stats.distance_computations,
        nodes_visited: stats.nodes_visited,
        pages_read: stats.pages_read,
        candidates_inspected: stats.candidates_inspected,
        pruned_by_geo: stats.pruned_by_geo,
        pruned_by_time: stats.pruned_by_time,
        segment_count: stats.segment_count,
        delta_segment_count: stats.delta_segment_count,
        loaded_segments: stats.loaded_segments,
        max_leaf_size: stats.max_leaf_size,
        pending_point_count: stats.pending_point_count,
        needs_optimization: stats.needs_optimization,
        query_purpose: None,
        storage_mode: None,
        query_time_ms: None,
        rows_returned: None,
        limit: None,
        offset: None,
        limit_reached: None,
        sql_plan: None,
    }
}

fn with_query_metrics(
    mut stats: SearchIndexStats,
    spec: &SearchSpec,
    storage_mode: &str,
    query_time_ms: f64,
    rows_returned: usize,
    limit: i64,
    offset: i64,
    limit_reached: bool,
    sql_plan: Option<SqlExplainPlan>,
) -> SearchIndexStats {
    stats.query_purpose = Some(spec.purpose.clone());
    stats.storage_mode = Some(storage_mode.to_string());
    stats.query_time_ms = Some(query_time_ms);
    if stats.last_query_time_ms.is_none() {
        stats.last_query_time_ms = Some(query_time_ms);
    }
    stats.rows_returned = Some(rows_returned);
    stats.limit = Some(limit);
    stats.offset = Some(offset);
    stats.limit_reached = Some(limit_reached);
    stats.sql_plan = sql_plan;
    stats
}

fn extract_sqlite_used_indexes(details: &[String]) -> Vec<String> {
    let mut indexes = BTreeSet::<String>::new();
    for detail in details {
        for marker in [
            "USING COVERING INDEX ",
            "USING INDEX ",
            "USING AUTOMATIC COVERING INDEX ",
            "USING AUTOMATIC INDEX ",
        ] {
            if let Some(start) = detail.find(marker) {
                let value = detail[start + marker.len()..]
                    .split(|ch: char| ch.is_whitespace() || ch == ')')
                    .next()
                    .unwrap_or("")
                    .trim();
                if !value.is_empty() {
                    indexes.insert(value.to_string());
                }
            }
        }
    }
    indexes.into_iter().collect()
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

fn distance_between_coords(a_lat: f64, a_lon: f64, b_lat: f64, b_lon: f64) -> f64 {
    let point_lat = to_radians(a_lat);
    let query_lat = to_radians(b_lat);
    let delta_lat = to_radians(b_lat - a_lat);
    let delta_lon = to_radians(b_lon - a_lon);
    let a = (delta_lat / 2.0).sin().powi(2)
        + point_lat.cos() * query_lat.cos() * (delta_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_METERS * a.sqrt().atan2((1.0 - a).sqrt())
}

fn distance_meters(point: &GeoIndexPoint, query: &GeoSearchQuery) -> f64 {
    distance_between_coords(point.lat, point.lon, query.lat, query.lon)
}

fn matches_time_range(timestamp: Option<i64>, query: &GeoSearchQuery) -> bool {
    if let Some(start_time) = query.start_time {
        if timestamp.is_none_or(|value| value < start_time) {
            return false;
        }
    }
    if let Some(end_time) = query.end_time {
        if timestamp.is_none_or(|value| value > end_time) {
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
    matches_time_range(point.timestamp, query)
        && matches_kind(point, query)
        && matches_geo_bounds(point, query)
}

fn kind_mask(kind: Option<&str>) -> u8 {
    match kind {
        Some("image") => 1,
        Some("video") => 2,
        Some("geo_point") => 4,
        _ => 8,
    }
}

fn query_kind_mask(query: &GeoSearchQuery) -> u8 {
    match query.kind.as_deref() {
        None | Some("all") => 15,
        Some("media") => 1 | 2,
        Some(kind) => kind_mask(Some(kind)),
    }
}

fn ball_node_overlaps_geo_bounds(node: &NativeBallNode, bounds: &GeoBounds) -> bool {
    !(node.lat_max < bounds.min_lat
        || node.lat_min > bounds.max_lat
        || node.lon_max < bounds.min_lon
        || node.lon_min > bounds.max_lon)
}

fn overlaps_time_range(
    min_timestamp: Option<i64>,
    max_timestamp: Option<i64>,
    query: &GeoSearchQuery,
) -> bool {
    if let Some(start_time) = query.start_time {
        if max_timestamp.is_some_and(|value| value < start_time) {
            return false;
        }
    }
    if let Some(end_time) = query.end_time {
        if min_timestamp.is_some_and(|value| value > end_time) {
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

impl NativeSegmentedKdTreeIndex {
    fn build(
        &mut self,
        points: &[GeoIndexPoint],
        mut on_progress: impl FnMut(usize) -> AppResult<()>,
    ) -> AppResult<()> {
        let start = Instant::now();
        self.segments.clear();
        self.pending_points.clear();
        self.disk_manifest = None;
        self.disk_dir = None;
        self.segment_cache.clear();
        on_progress(0)?;
        for (segment_index, chunk) in points.chunks(SEGMENTED_KD_TREE_SEGMENT_LIMIT).enumerate() {
            self.segments.push(NativeKdSegment {
                id: format!("segment-{segment_index:06}"),
                is_delta: false,
                points: chunk
                    .iter()
                    .filter_map(normalized_geo_index_point)
                    .collect::<Vec<_>>(),
                max_leaf_size: SEGMENTED_KD_TREE_LEAF_SIZE,
            });
            on_progress(((segment_index + 1) * SEGMENTED_KD_TREE_SEGMENT_LIMIT).min(points.len()))?;
        }
        self.last_stats =
            self.stats_with_timing(Some(start.elapsed().as_secs_f64() * 1000.0), None);
        Ok(())
    }

    #[allow(dead_code)]
    fn insert_many(&mut self, points: &[GeoIndexPoint]) {
        let start = Instant::now();
        self.disk_manifest = None;
        self.disk_dir = None;
        self.segment_cache.clear();
        self.pending_points
            .extend(points.iter().filter_map(normalized_geo_index_point));
        if self.pending_points.len() >= SEGMENTED_KD_TREE_DELTA_LIMIT {
            self.flush_pending();
        }
        self.last_stats =
            self.stats_with_timing(None, Some(start.elapsed().as_secs_f64() * 1000.0));
    }

    #[allow(dead_code)]
    fn flush_pending(&mut self) {
        if self.pending_points.is_empty() {
            return;
        }
        let points = std::mem::take(&mut self.pending_points);
        self.segments.push(NativeKdSegment {
            id: format!(
                "delta-{}-{}",
                current_timestamp_millis(),
                self.segments.len()
            ),
            is_delta: true,
            points,
            max_leaf_size: SEGMENTED_KD_TREE_LEAF_SIZE,
        });
        self.last_stats = self.stats_with_timing(None, None);
    }

    fn search(&mut self, query: &GeoSearchQuery) -> Vec<GeoSearchResult> {
        if self.disk_manifest.is_some() {
            return self.search_disk(query).unwrap_or_default();
        }
        let start = Instant::now();
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.k.max(0) as usize;
        let retained_limit = offset + limit;
        let mut stats = self.stats_with_timing(None, None);
        if limit == 0 || self.point_count() == 0 {
            stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            self.last_stats = stats;
            return Vec::new();
        }

        let mut top_k = Vec::<GeoSearchResult>::new();
        for segment in &self.segments {
            stats.nodes_visited += 1;
            stats.pages_read += 1;
            for point in &segment.points {
                stats.candidates_inspected += 1;
                if !matches_geo_search_query(point, query) {
                    continue;
                }
                stats.distance_computations += 1;
                top_k.push(GeoSearchResult {
                    media_id: point.media_id.clone(),
                    distance_meters: distance_meters(point, query),
                });
                if top_k.len() >= retained_limit {
                    sort_geo_results(&mut top_k);
                    top_k.truncate(retained_limit);
                }
            }
        }
        for point in &self.pending_points {
            stats.candidates_inspected += 1;
            if !matches_geo_search_query(point, query) {
                continue;
            }
            stats.distance_computations += 1;
            top_k.push(GeoSearchResult {
                media_id: point.media_id.clone(),
                distance_meters: distance_meters(point, query),
            });
            if top_k.len() >= retained_limit {
                sort_geo_results(&mut top_k);
                top_k.truncate(retained_limit);
            }
        }

        sort_geo_results(&mut top_k);
        stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
        self.last_stats = stats;
        top_k
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>()
    }

    fn snapshot(&self) -> NativeSegmentedKdTreeSnapshot {
        NativeSegmentedKdTreeSnapshot {
            engine_id: "segmented-kd-tree".to_string(),
            engine_version: 1,
            segment_point_limit: SEGMENTED_KD_TREE_SEGMENT_LIMIT,
            delta_flush_point_limit: SEGMENTED_KD_TREE_DELTA_LIMIT,
            leaf_size: SEGMENTED_KD_TREE_LEAF_SIZE,
            point_count: self.point_count(),
            segment_count: self.segments.len(),
            segments: self.segments.clone(),
            pending_points: self.pending_points.clone(),
        }
    }

    #[allow(dead_code)]
    fn restore(&mut self, snapshot: NativeSegmentedKdTreeSnapshot) -> AppResult<()> {
        if snapshot.engine_id != "segmented-kd-tree"
            || snapshot.engine_version != 1
            || snapshot.leaf_size != SEGMENTED_KD_TREE_LEAF_SIZE
        {
            return Err("Segmented KD-tree index snapshot is incompatible.".to_string());
        }
        self.segments = snapshot.segments;
        self.pending_points = snapshot.pending_points;
        self.disk_manifest = None;
        self.disk_dir = None;
        self.segment_cache.clear();
        if snapshot.point_count != self.point_count()
            || snapshot.segment_count != self.segments.len()
        {
            self.segments.clear();
            self.pending_points.clear();
            return Err("Segmented KD-tree index snapshot is incomplete.".to_string());
        }
        self.last_stats = self.stats_with_timing(Some(0.0), None);
        Ok(())
    }

    fn point_count(&self) -> usize {
        if let Some(manifest) = self.disk_manifest.as_ref() {
            return manifest.point_count + self.pending_points.len();
        }
        self.segments
            .iter()
            .map(|segment| segment.points.len())
            .sum::<usize>()
            + self.pending_points.len()
    }

    fn delta_segment_count(&self) -> usize {
        if let Some(manifest) = self.disk_manifest.as_ref() {
            return manifest
                .segments
                .iter()
                .filter(|segment| segment.is_delta)
                .count();
        }
        self.segments
            .iter()
            .filter(|segment| segment.is_delta)
            .count()
    }

    fn stats_with_timing(
        &self,
        build_time_ms: Option<f64>,
        insert_time_ms: Option<f64>,
    ) -> GeoIndexStats {
        let disk_index_size = self.disk_manifest.as_ref().map(|manifest| {
            manifest
                .segments
                .iter()
                .map(|segment| segment.byte_len)
                .sum::<usize>()
        });
        let resident_bytes = self
            .disk_manifest
            .as_ref()
            .and_then(|manifest| serde_json::to_vec(manifest).ok().map(|data| data.len()));
        GeoIndexStats {
            build_time_ms,
            insert_time_ms,
            index_size_bytes: disk_index_size
                .or(Some(self.point_count() * 48 + self.segments.len() * 96)),
            resident_bytes,
            index_storage: self.disk_manifest.as_ref().map(|_| "disk".to_string()),
            segment_count: Some(
                self.disk_manifest
                    .as_ref()
                    .map_or(self.segments.len(), |manifest| manifest.segments.len()),
            ),
            delta_segment_count: Some(self.delta_segment_count()),
            loaded_segments: Some(
                self.disk_manifest
                    .as_ref()
                    .map_or(self.segments.len(), |_| self.segment_cache.len()),
            ),
            loaded_pages: self
                .disk_manifest
                .as_ref()
                .map(|_| self.segment_cache.len()),
            max_leaf_size: Some(SEGMENTED_KD_TREE_LEAF_SIZE),
            pending_point_count: Some(self.pending_points.len()),
            needs_optimization: Some(self.delta_segment_count() >= 8),
            ..empty_geo_index_stats("segmented-kd-tree", self.point_count())
        }
    }

    fn restore_disk_manifest(
        &mut self,
        dir: PathBuf,
        manifest: NativeDiskSegmentedManifest,
        build_time_ms: Option<f64>,
    ) {
        self.segments.clear();
        self.pending_points.clear();
        self.segment_cache.clear();
        self.disk_dir = Some(dir);
        self.disk_manifest = Some(manifest);
        self.last_stats = self.stats_with_timing(build_time_ms, None);
    }

    fn load_disk_segment(
        &mut self,
        segment: &NativeDiskSegmentRef,
        stats: &mut GeoIndexStats,
    ) -> AppResult<NativeKdSegment> {
        if let Some((_, cached)) = self
            .segment_cache
            .iter()
            .find(|(id, _)| id == &segment.id)
            .cloned()
        {
            stats.page_cache_hits = Some(stats.page_cache_hits.unwrap_or(0) + 1);
            return Ok(cached);
        }
        stats.page_cache_misses = Some(stats.page_cache_misses.unwrap_or(0) + 1);
        let dir = self
            .disk_dir
            .as_ref()
            .ok_or_else(|| "Segmented KD-tree disk directory is not prepared.".to_string())?;
        let data =
            fs::read(segment_file_path(dir, &segment.id)).map_err(|error| error.to_string())?;
        stats.disk_read_bytes = Some(stats.disk_read_bytes.unwrap_or(0) + data.len());
        stats.disk_read_count = Some(stats.disk_read_count.unwrap_or(0) + 1);
        let loaded =
            serde_json::from_slice::<NativeKdSegment>(&data).map_err(|error| error.to_string())?;
        self.segment_cache
            .push_back((segment.id.clone(), loaded.clone()));
        while self.segment_cache.len() > 4 {
            self.segment_cache.pop_front();
        }
        Ok(loaded)
    }

    fn search_disk(&mut self, query: &GeoSearchQuery) -> AppResult<Vec<GeoSearchResult>> {
        let start = Instant::now();
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.k.max(0) as usize;
        let retained_limit = offset + limit;
        let manifest = self
            .disk_manifest
            .clone()
            .ok_or_else(|| "Segmented KD-tree disk index is not prepared.".to_string())?;
        let mut stats = self.stats_with_timing(None, None);
        stats.disk_read_bytes = Some(0);
        stats.disk_read_count = Some(0);
        stats.page_cache_hits = Some(0);
        stats.page_cache_misses = Some(0);
        if limit == 0 || manifest.point_count == 0 {
            stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            self.last_stats = stats;
            return Ok(Vec::new());
        }

        let mut top_k = Vec::<GeoSearchResult>::new();
        for segment_ref in &manifest.segments {
            stats.nodes_visited += 1;
            if !summary_matches_query(&segment_ref.summary, query) {
                stats.pruned_by_geo += 1;
                continue;
            }
            stats.pages_read += 1;
            let segment = self.load_disk_segment(segment_ref, &mut stats)?;
            for point in &segment.points {
                stats.candidates_inspected += 1;
                if !matches_geo_search_query(point, query) {
                    continue;
                }
                stats.distance_computations += 1;
                top_k.push(GeoSearchResult {
                    media_id: point.media_id.clone(),
                    distance_meters: distance_meters(point, query),
                });
                if top_k.len() >= retained_limit {
                    sort_geo_results(&mut top_k);
                    top_k.truncate(retained_limit);
                }
            }
        }

        sort_geo_results(&mut top_k);
        stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
        stats.loaded_segments = Some(self.segment_cache.len());
        stats.loaded_pages = Some(self.segment_cache.len());
        self.last_stats = stats;
        Ok(top_k.into_iter().skip(offset).take(limit).collect())
    }
}

impl NativeSegmentedBallTreeIndex {
    fn build(
        &mut self,
        points: &[GeoIndexPoint],
        mut on_progress: impl FnMut(usize) -> AppResult<()>,
    ) -> AppResult<()> {
        let start = Instant::now();
        self.segments.clear();
        self.pending_points.clear();
        self.disk_manifest = None;
        self.disk_dir = None;
        self.segment_cache.clear();
        on_progress(0)?;
        for (segment_index, chunk) in points.chunks(SEGMENTED_BALL_TREE_SEGMENT_LIMIT).enumerate() {
            if let Some(segment) = self.build_segment(
                format!("segment-{segment_index:06}"),
                chunk
                    .iter()
                    .filter_map(normalized_geo_index_point)
                    .collect::<Vec<_>>(),
                false,
            ) {
                self.segments.push(segment);
            }
            on_progress(
                ((segment_index + 1) * SEGMENTED_BALL_TREE_SEGMENT_LIMIT).min(points.len()),
            )?;
        }
        self.last_stats =
            self.stats_with_timing(Some(start.elapsed().as_secs_f64() * 1000.0), None);
        Ok(())
    }

    #[allow(dead_code)]
    fn insert_many(&mut self, points: &[GeoIndexPoint]) {
        let start = Instant::now();
        self.disk_manifest = None;
        self.disk_dir = None;
        self.segment_cache.clear();
        self.pending_points
            .extend(points.iter().filter_map(normalized_geo_index_point));
        if self.pending_points.len() >= SEGMENTED_BALL_TREE_DELTA_LIMIT {
            self.flush_pending();
        }
        self.last_stats =
            self.stats_with_timing(None, Some(start.elapsed().as_secs_f64() * 1000.0));
    }

    #[allow(dead_code)]
    fn flush_pending(&mut self) {
        if self.pending_points.is_empty() {
            return;
        }
        let points = std::mem::take(&mut self.pending_points);
        if let Some(segment) = self.build_segment(
            format!(
                "delta-{}-{}",
                current_timestamp_millis(),
                self.segments.len()
            ),
            points,
            true,
        ) {
            self.segments.push(segment);
        }
        self.last_stats = self.stats_with_timing(None, None);
    }

    fn search(&mut self, original_query: &GeoSearchQuery) -> Vec<GeoSearchResult> {
        if self.disk_manifest.is_some() {
            return self.search_disk(original_query).unwrap_or_default();
        }
        let start = Instant::now();
        let query = GeoSearchQuery {
            lon: normalize_lon(original_query.lon),
            ..original_query.clone()
        };
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.k.max(0) as usize;
        let retained_limit = offset + limit;
        let mut stats = self.stats_with_timing(None, None);
        if limit == 0 || self.point_count() == 0 {
            stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            self.last_stats = stats;
            return Vec::new();
        }

        let mut top_k = Vec::<GeoSearchResult>::new();
        let mut queue = Vec::<(usize, usize, f64)>::new();
        for (segment_index, segment) in self.segments.iter().enumerate() {
            if !segment.nodes.is_empty() {
                enqueue_ball_node(segment, segment_index, 0, &query, &mut stats, &mut queue);
            }
        }

        while !queue.is_empty() {
            queue.sort_by(|a, b| {
                b.2.partial_cmp(&a.2)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.1.cmp(&a.1))
            });
            let (segment_index, node_index, lower_bound) = queue.pop().unwrap();
            let worst = if top_k.len() == retained_limit {
                top_k
                    .last()
                    .map(|result| result.distance_meters)
                    .unwrap_or(f64::INFINITY)
            } else {
                f64::INFINITY
            };
            if top_k.len() == retained_limit && lower_bound > worst {
                stats.pruned_by_geo += (queue.len() + 1) as i64;
                break;
            }

            let segment = &self.segments[segment_index];
            let node = &segment.nodes[node_index];
            stats.nodes_visited += 1;
            if node.left.is_some() || node.right.is_some() {
                if let Some(left) = node.left {
                    enqueue_ball_node(segment, segment_index, left, &query, &mut stats, &mut queue);
                }
                if let Some(right) = node.right {
                    enqueue_ball_node(
                        segment,
                        segment_index,
                        right,
                        &query,
                        &mut stats,
                        &mut queue,
                    );
                }
                continue;
            }

            stats.pages_read += 1;
            for point in &segment.points[node.point_start..node.point_end] {
                stats.candidates_inspected += 1;
                if !matches_geo_search_query(point, &query) {
                    continue;
                }
                stats.distance_computations += 1;
                top_k.push(GeoSearchResult {
                    media_id: point.media_id.clone(),
                    distance_meters: distance_meters(point, &query),
                });
                if top_k.len() >= retained_limit {
                    sort_geo_results(&mut top_k);
                    top_k.truncate(retained_limit);
                }
            }
        }

        for point in &self.pending_points {
            stats.candidates_inspected += 1;
            if !matches_geo_search_query(point, &query) {
                continue;
            }
            stats.distance_computations += 1;
            top_k.push(GeoSearchResult {
                media_id: point.media_id.clone(),
                distance_meters: distance_meters(point, &query),
            });
            if top_k.len() >= retained_limit {
                sort_geo_results(&mut top_k);
                top_k.truncate(retained_limit);
            }
        }

        sort_geo_results(&mut top_k);
        stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
        self.last_stats = stats;
        top_k
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>()
    }

    fn snapshot(&self) -> NativeSegmentedBallTreeSnapshot {
        NativeSegmentedBallTreeSnapshot {
            engine_id: "segmented-ball-tree".to_string(),
            engine_version: 1,
            segment_point_limit: SEGMENTED_BALL_TREE_SEGMENT_LIMIT,
            delta_flush_point_limit: SEGMENTED_BALL_TREE_DELTA_LIMIT,
            leaf_size: SEGMENTED_BALL_TREE_LEAF_SIZE,
            point_count: self.point_count(),
            segment_count: self.segments.len(),
            segments: self.segments.clone(),
            pending_points: self.pending_points.clone(),
        }
    }

    #[allow(dead_code)]
    fn restore(&mut self, snapshot: NativeSegmentedBallTreeSnapshot) -> AppResult<()> {
        if snapshot.engine_id != "segmented-ball-tree"
            || snapshot.engine_version != 1
            || snapshot.leaf_size != SEGMENTED_BALL_TREE_LEAF_SIZE
        {
            return Err("Segmented ball-tree index snapshot is incompatible.".to_string());
        }
        self.segments = snapshot.segments;
        self.pending_points = snapshot.pending_points;
        self.disk_manifest = None;
        self.disk_dir = None;
        self.segment_cache.clear();
        if snapshot.point_count != self.point_count()
            || snapshot.segment_count != self.segments.len()
        {
            self.segments.clear();
            self.pending_points.clear();
            return Err("Segmented ball-tree index snapshot is incomplete.".to_string());
        }
        self.last_stats = self.stats_with_timing(Some(0.0), None);
        Ok(())
    }

    fn build_segment(
        &self,
        id: String,
        points: Vec<GeoIndexPoint>,
        is_delta: bool,
    ) -> Option<NativeBallSegment> {
        if points.is_empty() {
            return None;
        }
        let mut segment = NativeBallSegment {
            id,
            is_delta,
            nodes: Vec::new(),
            points: Vec::new(),
            point_count: points.len(),
            max_leaf_size: 0,
        };
        self.build_node(&mut segment, points);
        Some(segment)
    }

    fn build_node(&self, segment: &mut NativeBallSegment, points: Vec<GeoIndexPoint>) -> usize {
        let root_index = segment.nodes.len();
        segment.nodes.push(ball_node_for_points(&points));
        let mut stack = vec![(root_index, points)];

        while let Some((node_index, frame_points)) = stack.pop() {
            let node_base = segment.nodes[node_index].clone();
            if frame_points.len() <= SEGMENTED_BALL_TREE_LEAF_SIZE {
                write_ball_leaf(segment, node_index, node_base, frame_points);
                continue;
            }

            let (left_points, right_points) = split_ball_points(frame_points.clone(), &node_base);
            if left_points.is_empty() || right_points.is_empty() {
                write_ball_leaf(segment, node_index, node_base, frame_points);
                continue;
            }

            let left = segment.nodes.len();
            segment.nodes.push(ball_node_for_points(&left_points));
            let right = segment.nodes.len();
            segment.nodes.push(ball_node_for_points(&right_points));
            segment.nodes[node_index] = NativeBallNode {
                left: Some(left),
                right: Some(right),
                ..node_base
            };
            stack.push((right, right_points));
            stack.push((left, left_points));
        }

        root_index
    }

    fn point_count(&self) -> usize {
        if let Some(manifest) = self.disk_manifest.as_ref() {
            return manifest.point_count + self.pending_points.len();
        }
        self.segments
            .iter()
            .map(|segment| segment.point_count)
            .sum::<usize>()
            + self.pending_points.len()
    }

    fn delta_segment_count(&self) -> usize {
        if let Some(manifest) = self.disk_manifest.as_ref() {
            return manifest
                .segments
                .iter()
                .filter(|segment| segment.is_delta)
                .count();
        }
        self.segments
            .iter()
            .filter(|segment| segment.is_delta)
            .count()
    }

    fn max_leaf_size(&self) -> usize {
        if let Some(manifest) = self.disk_manifest.as_ref() {
            return manifest
                .segments
                .iter()
                .map(|segment| segment.max_leaf_size)
                .max()
                .unwrap_or(0);
        }
        self.segments
            .iter()
            .map(|segment| segment.max_leaf_size)
            .max()
            .unwrap_or(0)
    }

    fn stats_with_timing(
        &self,
        build_time_ms: Option<f64>,
        insert_time_ms: Option<f64>,
    ) -> GeoIndexStats {
        let disk_index_size = self.disk_manifest.as_ref().map(|manifest| {
            manifest
                .segments
                .iter()
                .map(|segment| segment.byte_len)
                .sum::<usize>()
        });
        let resident_bytes = self
            .disk_manifest
            .as_ref()
            .and_then(|manifest| serde_json::to_vec(manifest).ok().map(|data| data.len()));
        GeoIndexStats {
            build_time_ms,
            insert_time_ms,
            index_size_bytes: disk_index_size
                .or(Some(self.point_count() * 48 + self.segments.len() * 120)),
            resident_bytes,
            index_storage: self.disk_manifest.as_ref().map(|_| "disk".to_string()),
            segment_count: Some(
                self.disk_manifest
                    .as_ref()
                    .map_or(self.segments.len(), |manifest| manifest.segments.len()),
            ),
            delta_segment_count: Some(self.delta_segment_count()),
            loaded_segments: Some(
                self.disk_manifest
                    .as_ref()
                    .map_or(self.segments.len(), |_| self.segment_cache.len()),
            ),
            loaded_pages: self
                .disk_manifest
                .as_ref()
                .map(|_| self.segment_cache.len()),
            max_leaf_size: Some(self.max_leaf_size()),
            pending_point_count: Some(self.pending_points.len()),
            needs_optimization: Some(self.delta_segment_count() >= 8),
            ..empty_geo_index_stats("segmented-ball-tree", self.point_count())
        }
    }

    fn restore_disk_manifest(
        &mut self,
        dir: PathBuf,
        manifest: NativeDiskSegmentedManifest,
        build_time_ms: Option<f64>,
    ) {
        self.segments.clear();
        self.pending_points.clear();
        self.segment_cache.clear();
        self.disk_dir = Some(dir);
        self.disk_manifest = Some(manifest);
        self.last_stats = self.stats_with_timing(build_time_ms, None);
    }

    fn load_disk_segment(
        &mut self,
        segment: &NativeDiskSegmentRef,
        stats: &mut GeoIndexStats,
    ) -> AppResult<NativeBallSegment> {
        if let Some((_, cached)) = self
            .segment_cache
            .iter()
            .find(|(id, _)| id == &segment.id)
            .cloned()
        {
            stats.page_cache_hits = Some(stats.page_cache_hits.unwrap_or(0) + 1);
            return Ok(cached);
        }
        stats.page_cache_misses = Some(stats.page_cache_misses.unwrap_or(0) + 1);
        let dir = self
            .disk_dir
            .as_ref()
            .ok_or_else(|| "Segmented ball-tree disk directory is not prepared.".to_string())?;
        let data =
            fs::read(segment_file_path(dir, &segment.id)).map_err(|error| error.to_string())?;
        stats.disk_read_bytes = Some(stats.disk_read_bytes.unwrap_or(0) + data.len());
        stats.disk_read_count = Some(stats.disk_read_count.unwrap_or(0) + 1);
        let loaded = serde_json::from_slice::<NativeBallSegment>(&data)
            .map_err(|error| error.to_string())?;
        self.segment_cache
            .push_back((segment.id.clone(), loaded.clone()));
        while self.segment_cache.len() > 4 {
            self.segment_cache.pop_front();
        }
        Ok(loaded)
    }

    fn search_disk(&mut self, original_query: &GeoSearchQuery) -> AppResult<Vec<GeoSearchResult>> {
        let start = Instant::now();
        let query = GeoSearchQuery {
            lon: normalize_lon(original_query.lon),
            ..original_query.clone()
        };
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.k.max(0) as usize;
        let retained_limit = offset + limit;
        let manifest = self
            .disk_manifest
            .clone()
            .ok_or_else(|| "Segmented ball-tree disk index is not prepared.".to_string())?;
        let mut stats = self.stats_with_timing(None, None);
        stats.disk_read_bytes = Some(0);
        stats.disk_read_count = Some(0);
        stats.page_cache_hits = Some(0);
        stats.page_cache_misses = Some(0);
        if limit == 0 || manifest.point_count == 0 {
            stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            self.last_stats = stats;
            return Ok(Vec::new());
        }

        let mut top_k = Vec::<GeoSearchResult>::new();
        let mut queue = Vec::<(NativeDiskSegmentRef, usize, f64)>::new();
        for segment_ref in &manifest.segments {
            if !summary_matches_query(&segment_ref.summary, &query) {
                stats.pruned_by_geo += 1;
                continue;
            }
            stats.pages_read += 1;
            let segment = self.load_disk_segment(segment_ref, &mut stats)?;
            if !segment.nodes.is_empty() {
                enqueue_ball_node_for_ref(
                    segment_ref.clone(),
                    &segment,
                    0,
                    &query,
                    &mut stats,
                    &mut queue,
                );
            }
        }

        while !queue.is_empty() {
            queue.sort_by(|a, b| {
                b.2.partial_cmp(&a.2)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.1.cmp(&a.1))
            });
            let (segment_ref, node_index, lower_bound) = queue.pop().unwrap();
            let worst = if top_k.len() == retained_limit {
                top_k
                    .last()
                    .map(|result| result.distance_meters)
                    .unwrap_or(f64::INFINITY)
            } else {
                f64::INFINITY
            };
            if top_k.len() == retained_limit && lower_bound > worst {
                stats.pruned_by_geo += (queue.len() + 1) as i64;
                break;
            }

            let segment = self.load_disk_segment(&segment_ref, &mut stats)?;
            let node = &segment.nodes[node_index];
            stats.nodes_visited += 1;
            if node.left.is_some() || node.right.is_some() {
                if let Some(left) = node.left {
                    enqueue_ball_node_for_ref(
                        segment_ref.clone(),
                        &segment,
                        left,
                        &query,
                        &mut stats,
                        &mut queue,
                    );
                }
                if let Some(right) = node.right {
                    enqueue_ball_node_for_ref(
                        segment_ref.clone(),
                        &segment,
                        right,
                        &query,
                        &mut stats,
                        &mut queue,
                    );
                }
                continue;
            }

            for point in &segment.points[node.point_start..node.point_end] {
                stats.candidates_inspected += 1;
                if !matches_geo_search_query(point, &query) {
                    continue;
                }
                stats.distance_computations += 1;
                top_k.push(GeoSearchResult {
                    media_id: point.media_id.clone(),
                    distance_meters: distance_meters(point, &query),
                });
                if top_k.len() >= retained_limit {
                    sort_geo_results(&mut top_k);
                    top_k.truncate(retained_limit);
                }
            }
        }

        sort_geo_results(&mut top_k);
        stats.last_query_time_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
        stats.loaded_segments = Some(self.segment_cache.len());
        stats.loaded_pages = Some(self.segment_cache.len());
        self.last_stats = stats;
        Ok(top_k.into_iter().skip(offset).take(limit).collect())
    }
}

fn enqueue_ball_node(
    segment: &NativeBallSegment,
    segment_index: usize,
    node_index: usize,
    query: &GeoSearchQuery,
    stats: &mut GeoIndexStats,
    queue: &mut Vec<(usize, usize, f64)>,
) {
    let Some(node) = segment.nodes.get(node_index) else {
        return;
    };
    if !overlaps_time_range(node.min_timestamp, node.max_timestamp, query) {
        stats.pruned_by_time += 1;
        return;
    }
    if node.kind_mask & query_kind_mask(query) == 0 {
        stats.pruned_by_geo += 1;
        return;
    }
    if let Some(bounds) = query.geo_bounds.as_ref() {
        if !ball_node_overlaps_geo_bounds(node, bounds) {
            stats.pruned_by_geo += 1;
            return;
        }
    }
    let lower_bound =
        (distance_between_coords(node.center_lat, node.center_lon, query.lat, query.lon)
            - node.radius_meters)
            .max(0.0);
    queue.push((segment_index, node_index, lower_bound));
}

fn enqueue_ball_node_for_ref(
    segment_ref: NativeDiskSegmentRef,
    segment: &NativeBallSegment,
    node_index: usize,
    query: &GeoSearchQuery,
    stats: &mut GeoIndexStats,
    queue: &mut Vec<(NativeDiskSegmentRef, usize, f64)>,
) {
    let Some(node) = segment.nodes.get(node_index) else {
        return;
    };
    if !overlaps_time_range(node.min_timestamp, node.max_timestamp, query) {
        stats.pruned_by_time += 1;
        return;
    }
    if node.kind_mask & query_kind_mask(query) == 0 {
        stats.pruned_by_geo += 1;
        return;
    }
    if let Some(bounds) = query.geo_bounds.as_ref() {
        if !ball_node_overlaps_geo_bounds(node, bounds) {
            stats.pruned_by_geo += 1;
            return;
        }
    }
    let lower_bound =
        (distance_between_coords(node.center_lat, node.center_lon, query.lat, query.lon)
            - node.radius_meters)
            .max(0.0);
    queue.push((segment_ref, node_index, lower_bound));
}

fn write_ball_leaf(
    segment: &mut NativeBallSegment,
    node_index: usize,
    node_base: NativeBallNode,
    mut points: Vec<GeoIndexPoint>,
) {
    let point_start = segment.points.len();
    points.sort_by(|a, b| a.media_id.cmp(&b.media_id));
    let point_end = point_start + points.len();
    segment.max_leaf_size = segment.max_leaf_size.max(points.len());
    segment.points.extend(points);
    segment.nodes[node_index] = NativeBallNode {
        point_start,
        point_end,
        ..node_base
    };
}

fn ball_node_for_points(points: &[GeoIndexPoint]) -> NativeBallNode {
    let mut lat_min = f64::INFINITY;
    let mut lat_max = f64::NEG_INFINITY;
    let mut lon_min = f64::INFINITY;
    let mut lon_max = f64::NEG_INFINITY;
    let mut lat_sum = 0.0;
    let mut lon_sum = 0.0;
    let mut min_timestamp = None;
    let mut max_timestamp = None;
    let mut node_kind_mask = 0_u8;

    for point in points {
        lat_min = lat_min.min(point.lat);
        lat_max = lat_max.max(point.lat);
        lon_min = lon_min.min(point.lon);
        lon_max = lon_max.max(point.lon);
        lat_sum += point.lat;
        lon_sum += point.lon;
        node_kind_mask |= kind_mask(point.kind.as_deref());
        if let Some(timestamp) = point.timestamp {
            if min_timestamp.is_none_or(|value| timestamp < value) {
                min_timestamp = Some(timestamp);
            }
            if max_timestamp.is_none_or(|value| timestamp > value) {
                max_timestamp = Some(timestamp);
            }
        }
    }

    let center_lat = lat_sum / points.len() as f64;
    let center_lon = normalize_lon(lon_sum / points.len() as f64);
    let radius_meters = points
        .iter()
        .map(|point| distance_between_coords(point.lat, point.lon, center_lat, center_lon))
        .fold(0.0, f64::max);

    NativeBallNode {
        left: None,
        right: None,
        point_start: 0,
        point_end: 0,
        center_lat,
        center_lon,
        radius_meters,
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        min_timestamp,
        max_timestamp,
        kind_mask: node_kind_mask,
    }
}

fn split_ball_points(
    points: Vec<GeoIndexPoint>,
    node: &NativeBallNode,
) -> (Vec<GeoIndexPoint>, Vec<GeoIndexPoint>) {
    let seed = points[0].clone();
    let pivot_a = farthest_ball_point(&seed, &points);
    let pivot_b = farthest_ball_point(&pivot_a, &points);
    let points_len = points.len();
    let mut left = Vec::new();
    let mut right = Vec::new();

    for point in points {
        let distance_a = distance_between_coords(point.lat, point.lon, pivot_a.lat, pivot_a.lon);
        let distance_b = distance_between_coords(point.lat, point.lon, pivot_b.lat, pivot_b.lon);
        if distance_a < distance_b
            || (distance_a == distance_b && point.media_id <= pivot_a.media_id)
        {
            left.push(point);
        } else {
            right.push(point);
        }
    }

    let smallest_partition = left.len().min(right.len());
    let min_balanced_partition = (points_len / 8).max(1);
    if !left.is_empty() && !right.is_empty() && smallest_partition >= min_balanced_partition {
        return (left, right);
    }

    let mut sorted = left;
    sorted.extend(right);
    if node.lon_max - node.lon_min > node.lat_max - node.lat_min {
        sorted.sort_by(|a, b| {
            a.lon
                .partial_cmp(&b.lon)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.media_id.cmp(&b.media_id))
        });
    } else {
        sorted.sort_by(|a, b| {
            a.lat
                .partial_cmp(&b.lat)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.media_id.cmp(&b.media_id))
        });
    }
    let middle = (sorted.len() / 2).max(1);
    let right = sorted.split_off(middle);
    (sorted, right)
}

fn farthest_ball_point(from: &GeoIndexPoint, points: &[GeoIndexPoint]) -> GeoIndexPoint {
    let mut farthest = points[0].clone();
    let mut farthest_distance = -1.0;
    for point in points {
        let distance = distance_between_coords(point.lat, point.lon, from.lat, from.lon);
        if distance > farthest_distance
            || (distance == farthest_distance && point.media_id < farthest.media_id)
        {
            farthest = point.clone();
            farthest_distance = distance;
        }
    }
    farthest
}

fn normalized_geo_index_point(point: &GeoIndexPoint) -> Option<GeoIndexPoint> {
    if !point.lat.is_finite() || !point.lon.is_finite() {
        return None;
    }
    Some(GeoIndexPoint {
        media_id: point.media_id.clone(),
        kind: point.kind.clone(),
        lat: point.lat,
        lon: normalize_lon(point.lon),
        timestamp: point.timestamp,
    })
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
            if !overlaps_time_range(cell.min_timestamp, cell.max_timestamp, query) {
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
            timestamp: point.timestamp,
        };
        let (key, z, lat_min, lat_max) = cell_address(&normalized);
        let cell = self.cells.entry(key).or_insert_with(|| NativeCell {
            z,
            lat_min,
            lat_max,
            min_timestamp: None,
            max_timestamp: None,
            points: Vec::new(),
        });
        update_cell_time_range(cell, normalized.timestamp);
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

fn update_cell_time_range(cell: &mut NativeCell, timestamp: Option<i64>) {
    let Some(timestamp) = timestamp else {
        return;
    };
    if cell.min_timestamp.is_none_or(|value| timestamp < value) {
        cell.min_timestamp = Some(timestamp);
    }
    if cell.max_timestamp.is_none_or(|value| timestamp > value) {
        cell.max_timestamp = Some(timestamp);
    }
}

fn kind_to_byte(kind: Option<&str>) -> u8 {
    match kind {
        Some("image") => 1,
        Some("video") => 2,
        Some("geo_point") => 3,
        _ => 0,
    }
}

fn byte_to_kind(value: u8) -> Option<String> {
    match value {
        1 => Some("image".to_string()),
        2 => Some("video".to_string()),
        3 => Some("geo_point".to_string()),
        _ => None,
    }
}

fn write_u8(output: &mut Vec<u8>, value: u8) {
    output.push(value);
}

fn write_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_f64(output: &mut Vec<u8>, value: f64) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_optional_i64_as_f64(output: &mut Vec<u8>, value: Option<i64>) {
    write_f64(output, value.map(|value| value as f64).unwrap_or(f64::NAN));
}

fn write_string(output: &mut Vec<u8>, value: &str) -> AppResult<()> {
    let bytes = value.as_bytes();
    let length = u32::try_from(bytes.len()).map_err(|error| error.to_string())?;
    write_u32(output, length);
    output.extend_from_slice(bytes);
    Ok(())
}

fn read_exact<'a>(input: &'a [u8], offset: &mut usize, length: usize) -> AppResult<&'a [u8]> {
    if input.len().saturating_sub(*offset) < length {
        return Err("Dynamic Z-order index data is truncated.".to_string());
    }
    let slice = &input[*offset..*offset + length];
    *offset += length;
    Ok(slice)
}

fn read_u8(input: &[u8], offset: &mut usize) -> AppResult<u8> {
    Ok(read_exact(input, offset, 1)?[0])
}

fn read_u32(input: &[u8], offset: &mut usize) -> AppResult<u32> {
    let bytes: [u8; 4] = read_exact(input, offset, 4)?
        .try_into()
        .map_err(|_| "Invalid u32 bytes.".to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_f64(input: &[u8], offset: &mut usize) -> AppResult<f64> {
    let bytes: [u8; 8] = read_exact(input, offset, 8)?
        .try_into()
        .map_err(|_| "Invalid f64 bytes.".to_string())?;
    Ok(f64::from_le_bytes(bytes))
}

fn read_optional_i64_from_f64(input: &[u8], offset: &mut usize) -> AppResult<Option<i64>> {
    let value = read_f64(input, offset)?;
    Ok((!value.is_nan()).then_some(value as i64))
}

fn read_string(input: &[u8], offset: &mut usize) -> AppResult<String> {
    let length = read_u32(input, offset)? as usize;
    let bytes = read_exact(input, offset, length)?;
    String::from_utf8(bytes.to_vec()).map_err(|error| error.to_string())
}

fn encode_dynamic_index(index: &NativeDynamicZOrderIndex) -> AppResult<Vec<u8>> {
    let mut output = Vec::new();
    output.extend_from_slice(DYNAMIC_INDEX_MAGIC);
    write_u32(&mut output, DYNAMIC_INDEX_FORMAT_VERSION);
    write_u32(&mut output, DYNAMIC_Z_ORDER_RESOLUTION);
    write_u32(&mut output, index.cells.len() as u32);
    write_u32(&mut output, index.point_count as u32);

    let mut cells = index.cells.iter().collect::<Vec<_>>();
    cells.sort_by(|(a_key, a_cell), (b_key, b_cell)| {
        a_cell.z.cmp(&b_cell.z).then_with(|| a_key.cmp(b_key))
    });

    for (key, cell) in cells {
        write_string(&mut output, key)?;
        write_u32(&mut output, cell.z);
        write_f64(&mut output, cell.lat_min);
        write_f64(&mut output, cell.lat_max);
        write_optional_i64_as_f64(&mut output, cell.min_timestamp);
        write_optional_i64_as_f64(&mut output, cell.max_timestamp);
        write_u32(&mut output, cell.points.len() as u32);

        let mut points = cell.points.clone();
        points.sort_by(|a, b| a.media_id.cmp(&b.media_id));
        for point in points {
            write_string(&mut output, &point.media_id)?;
            write_u8(&mut output, kind_to_byte(point.kind.as_deref()));
            write_f64(&mut output, point.lat);
            write_f64(&mut output, point.lon);
            write_optional_i64_as_f64(&mut output, point.timestamp);
        }
    }

    Ok(output)
}

fn decode_dynamic_index(input: &[u8]) -> AppResult<NativeDynamicZOrderIndex> {
    let mut offset = 0_usize;
    if read_exact(input, &mut offset, DYNAMIC_INDEX_MAGIC.len())? != DYNAMIC_INDEX_MAGIC {
        return Err("Dynamic Z-order index data has an invalid header.".to_string());
    }
    let version = read_u32(input, &mut offset)?;
    if version != DYNAMIC_INDEX_FORMAT_VERSION {
        return Err("Dynamic Z-order index data version is unsupported.".to_string());
    }
    let resolution = read_u32(input, &mut offset)?;
    if resolution != DYNAMIC_Z_ORDER_RESOLUTION {
        return Err("Dynamic Z-order index resolution is incompatible.".to_string());
    }
    let cell_count = read_u32(input, &mut offset)? as usize;
    let point_count = read_u32(input, &mut offset)? as usize;
    let mut cells = HashMap::new();
    let mut decoded_points = 0_usize;

    for _ in 0..cell_count {
        let key = read_string(input, &mut offset)?;
        let z = read_u32(input, &mut offset)?;
        let lat_min = read_f64(input, &mut offset)?;
        let lat_max = read_f64(input, &mut offset)?;
        let min_timestamp = read_optional_i64_from_f64(input, &mut offset)?;
        let max_timestamp = read_optional_i64_from_f64(input, &mut offset)?;
        let cell_point_count = read_u32(input, &mut offset)? as usize;
        let mut points = Vec::with_capacity(cell_point_count);

        for _ in 0..cell_point_count {
            let media_id = read_string(input, &mut offset)?;
            let kind = byte_to_kind(read_u8(input, &mut offset)?);
            let lat = read_f64(input, &mut offset)?;
            let lon = read_f64(input, &mut offset)?;
            let timestamp = read_optional_i64_from_f64(input, &mut offset)?;
            points.push(GeoIndexPoint {
                media_id,
                kind,
                lat,
                lon,
                timestamp,
            });
        }

        decoded_points += points.len();
        cells.insert(
            key,
            NativeCell {
                z,
                lat_min,
                lat_max,
                min_timestamp,
                max_timestamp,
                points,
            },
        );
    }

    if offset != input.len() || decoded_points != point_count || cells.len() != cell_count {
        return Err("Dynamic Z-order index data count mismatch.".to_string());
    }

    Ok(NativeDynamicZOrderIndex {
        cells,
        point_count,
        last_stats: GeoIndexStats {
            index_size_bytes: Some(point_count * 48 + cell_count * 96),
            build_time_ms: Some(0.0),
            ..empty_geo_index_stats("dynamic-z-order-cells", point_count)
        },
    })
}

fn checksum_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn current_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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

fn dynamic_index_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app_data_dir(app)?
        .join("indexes")
        .join("dynamic-z-order-cells")
        .join("v1");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn segmented_kd_tree_index_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app_data_dir(app)?
        .join("indexes")
        .join("segmented-kd-tree")
        .join("v1");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn segmented_ball_tree_index_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app_data_dir(app)?
        .join("indexes")
        .join("segmented-ball-tree")
        .join("v1");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn disk_segmented_index_dir(app: &AppHandle, engine_id: &str) -> AppResult<PathBuf> {
    let dir = app_data_dir(app)?
        .join("indexes")
        .join(engine_id)
        .join("v2");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn reset_directory(dir: &Path) -> AppResult<()> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    Ok(())
}

fn segment_file_path(dir: &Path, segment_id: &str) -> PathBuf {
    dir.join(format!("{segment_id}.json"))
}

fn summary_for_points(points: &[GeoIndexPoint]) -> NativeSegmentSummary {
    let mut lat_min = f64::INFINITY;
    let mut lat_max = f64::NEG_INFINITY;
    let mut lon_min = f64::INFINITY;
    let mut lon_max = f64::NEG_INFINITY;
    let mut min_timestamp: Option<i64> = None;
    let mut max_timestamp: Option<i64> = None;
    let mut mask = 0_u8;

    for point in points {
        lat_min = lat_min.min(point.lat);
        lat_max = lat_max.max(point.lat);
        lon_min = lon_min.min(point.lon);
        lon_max = lon_max.max(point.lon);
        if let Some(timestamp) = point.timestamp {
            min_timestamp = Some(min_timestamp.map_or(timestamp, |value| value.min(timestamp)));
            max_timestamp = Some(max_timestamp.map_or(timestamp, |value| value.max(timestamp)));
        }
        mask |= kind_mask(point.kind.as_deref());
    }

    NativeSegmentSummary {
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        min_timestamp,
        max_timestamp,
        kind_mask: mask,
    }
}

fn summary_matches_query(summary: &NativeSegmentSummary, query: &GeoSearchQuery) -> bool {
    if !overlaps_time_range(summary.min_timestamp, summary.max_timestamp, query) {
        return false;
    }
    if summary.kind_mask & query_kind_mask(query) == 0 {
        return false;
    }
    if let Some(bounds) = query.geo_bounds.as_ref() {
        if summary.lat_max < bounds.min_lat
            || summary.lat_min > bounds.max_lat
            || summary.lon_max < bounds.min_lon
            || summary.lon_min > bounds.max_lon
        {
            return false;
        }
    }
    true
}

fn validate_dynamic_manifest(manifest: &DynamicIndexManifest, catalog_epoch: i64) -> AppResult<()> {
    if manifest.engine_id != "dynamic-z-order-cells"
        || manifest.engine_version != 1
        || manifest.resolution != DYNAMIC_Z_ORDER_RESOLUTION
        || manifest.catalog_epoch != catalog_epoch
    {
        return Err("Dynamic Z-order index manifest does not match catalog.".to_string());
    }
    Ok(())
}

fn load_persisted_dynamic_index(
    app: &AppHandle,
    catalog_epoch: i64,
) -> AppResult<Option<(usize, usize)>> {
    let dir = dynamic_index_dir(app)?;
    let manifest_path = dir.join("manifest.json");
    let data_path = dir.join("index.bin");
    if !manifest_path.exists() || !data_path.exists() {
        return Ok(None);
    }

    let manifest = match fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<DynamicIndexManifest>(&content).ok())
    {
        Some(manifest) => manifest,
        None => return Ok(None),
    };
    if validate_dynamic_manifest(&manifest, catalog_epoch).is_err() {
        return Ok(None);
    }

    let data = match fs::read(&data_path) {
        Ok(data) => data,
        Err(_) => return Ok(None),
    };
    if checksum_hex(&data) != manifest.data_checksum {
        return Ok(None);
    }

    let index = match decode_dynamic_index(&data) {
        Ok(index) => index,
        Err(_) => return Ok(None),
    };
    if index.point_count != manifest.point_count || index.cells.len() != manifest.cell_count {
        return Ok(None);
    }

    let point_count = index.point_count;
    let cell_count = index.cells.len();
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    registry.dynamic_z_order = index;
    Ok(Some((point_count, cell_count)))
}

fn save_persisted_dynamic_index(app: &AppHandle, catalog_epoch: i64) -> AppResult<()> {
    let dir = dynamic_index_dir(app)?;
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let data = encode_dynamic_index(&registry.dynamic_z_order)?;
    let manifest = DynamicIndexManifest {
        engine_id: "dynamic-z-order-cells".to_string(),
        engine_version: 1,
        resolution: DYNAMIC_Z_ORDER_RESOLUTION,
        catalog_epoch,
        point_count: registry.dynamic_z_order.point_count,
        cell_count: registry.dynamic_z_order.cells.len(),
        created_at: current_timestamp_millis(),
        data_checksum: checksum_hex(&data),
    };
    drop(registry);

    let mut data_file = File::create(dir.join("index.bin")).map_err(|error| error.to_string())?;
    data_file
        .write_all(&data)
        .map_err(|error| error.to_string())?;
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[allow(dead_code)]
fn validate_segmented_kd_tree_manifest(
    manifest: &SegmentedKdTreeManifest,
    catalog_epoch: i64,
) -> AppResult<()> {
    if manifest.engine_id != "segmented-kd-tree"
        || manifest.engine_version != 1
        || manifest.catalog_epoch != catalog_epoch
    {
        return Err("Segmented KD-tree index manifest does not match catalog.".to_string());
    }
    Ok(())
}

fn load_persisted_segmented_kd_tree_index(
    app: &AppHandle,
    catalog_epoch: i64,
) -> AppResult<Option<(usize, usize)>> {
    let dir = disk_segmented_index_dir(app, "segmented-kd-tree")?;
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest = match fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<NativeDiskSegmentedManifest>(&content).ok())
    {
        Some(manifest) => manifest,
        None => return Ok(None),
    };
    if validate_disk_segmented_manifest(&manifest, "segmented-kd-tree", catalog_epoch).is_err() {
        return Ok(None);
    }
    if manifest
        .segments
        .iter()
        .any(|segment| !segment_file_path(&dir, &segment.id).exists())
    {
        return Ok(None);
    }

    let point_count = manifest.point_count;
    let segment_count = manifest.segment_count;
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    registry
        .segmented_kd_tree
        .restore_disk_manifest(dir, manifest, Some(0.0));
    Ok(Some((point_count, segment_count)))
}

fn save_persisted_segmented_kd_tree_index(app: &AppHandle, catalog_epoch: i64) -> AppResult<()> {
    let dir = segmented_kd_tree_index_dir(app)?;
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let snapshot = registry.segmented_kd_tree.snapshot();
    let data = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    let manifest = SegmentedKdTreeManifest {
        engine_id: "segmented-kd-tree".to_string(),
        engine_version: 1,
        catalog_epoch,
        point_count: snapshot.point_count,
        segment_count: snapshot.segment_count,
        created_at: current_timestamp_millis(),
        data_checksum: checksum_hex(&data),
    };
    drop(registry);

    let mut data_file = File::create(dir.join("index.json")).map_err(|error| error.to_string())?;
    data_file
        .write_all(&data)
        .map_err(|error| error.to_string())?;
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[allow(dead_code)]
fn validate_segmented_ball_tree_manifest(
    manifest: &SegmentedBallTreeManifest,
    catalog_epoch: i64,
) -> AppResult<()> {
    if manifest.engine_id != "segmented-ball-tree"
        || manifest.engine_version != 1
        || manifest.catalog_epoch != catalog_epoch
    {
        return Err("Segmented ball-tree index manifest does not match catalog.".to_string());
    }
    Ok(())
}

fn validate_disk_segmented_manifest(
    manifest: &NativeDiskSegmentedManifest,
    engine_id: &str,
    catalog_epoch: i64,
) -> AppResult<()> {
    if manifest.engine_id != engine_id
        || manifest.engine_version != 2
        || manifest.catalog_epoch != catalog_epoch
    {
        return Err("Segmented disk index manifest does not match catalog.".to_string());
    }
    Ok(())
}

fn load_persisted_segmented_ball_tree_index(
    app: &AppHandle,
    catalog_epoch: i64,
) -> AppResult<Option<(usize, usize)>> {
    let dir = disk_segmented_index_dir(app, "segmented-ball-tree")?;
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest = match fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<NativeDiskSegmentedManifest>(&content).ok())
    {
        Some(manifest) => manifest,
        None => return Ok(None),
    };
    if validate_disk_segmented_manifest(&manifest, "segmented-ball-tree", catalog_epoch).is_err() {
        return Ok(None);
    }
    if manifest
        .segments
        .iter()
        .any(|segment| !segment_file_path(&dir, &segment.id).exists())
    {
        return Ok(None);
    }

    let point_count = manifest.point_count;
    let segment_count = manifest.segment_count;
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    registry
        .segmented_ball_tree
        .restore_disk_manifest(dir, manifest, Some(0.0));
    Ok(Some((point_count, segment_count)))
}

fn save_persisted_segmented_ball_tree_index(app: &AppHandle, catalog_epoch: i64) -> AppResult<()> {
    let dir = segmented_ball_tree_index_dir(app)?;
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let snapshot = registry.segmented_ball_tree.snapshot();
    let data = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    let manifest = SegmentedBallTreeManifest {
        engine_id: "segmented-ball-tree".to_string(),
        engine_version: 1,
        catalog_epoch,
        point_count: snapshot.point_count,
        segment_count: snapshot.segment_count,
        created_at: current_timestamp_millis(),
        data_checksum: checksum_hex(&data),
    };
    drop(registry);

    let mut data_file = File::create(dir.join("index.json")).map_err(|error| error.to_string())?;
    data_file
        .write_all(&data)
        .map_err(|error| error.to_string())?;
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn build_disk_segmented_kd_tree_index(
    app: &AppHandle,
    window: &Window,
    catalog_epoch: i64,
    total_indexes: usize,
    selected_index_label: &str,
) -> AppResult<usize> {
    let started = Instant::now();
    let dir = disk_segmented_index_dir(app, "segmented-kd-tree")?;
    reset_directory(&dir)?;
    let conn = connect(app)?;
    let mut segments = Vec::<NativeDiskSegmentRef>::new();
    let mut point_count = 0_usize;

    for_each_geo_point_batch(
        &conn,
        SEGMENTED_KD_TREE_SEGMENT_LIMIT,
        |batch, processed_points| {
            let points = batch
                .iter()
                .filter_map(normalized_geo_index_point)
                .collect::<Vec<_>>();
            if !points.is_empty() {
                let id = format!("segment-{:06}", segments.len());
                let segment = NativeKdSegment {
                    id: id.clone(),
                    is_delta: false,
                    max_leaf_size: SEGMENTED_KD_TREE_LEAF_SIZE,
                    points,
                };
                let data = serde_json::to_vec(&segment).map_err(|error| error.to_string())?;
                fs::write(segment_file_path(&dir, &id), &data)
                    .map_err(|error| error.to_string())?;
                let summary = summary_for_points(&segment.points);
                point_count += segment.points.len();
                segments.push(NativeDiskSegmentRef {
                    id,
                    is_delta: false,
                    point_count: segment.points.len(),
                    max_leaf_size: segment.max_leaf_size,
                    byte_len: data.len(),
                    summary,
                });
            }
            emit_geo_index_progress(
                window,
                GeoIndexBuildProgress {
                    phase: "building".to_string(),
                    point_count: processed_points,
                    built_indexes: 0,
                    total_indexes,
                    current_index_id: Some("segmented-kd-tree".to_string()),
                    current_index_label: Some(selected_index_label.to_string()),
                    current_index_processed_points: Some(processed_points),
                    current_index_total_points: None,
                },
            );
            Ok(())
        },
    )?;

    let manifest = NativeDiskSegmentedManifest {
        engine_id: "segmented-kd-tree".to_string(),
        engine_version: 2,
        catalog_epoch,
        point_count,
        segment_count: segments.len(),
        created_at: current_timestamp_millis(),
        segments,
    };
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    registry.segmented_kd_tree.restore_disk_manifest(
        dir,
        manifest,
        Some(started.elapsed().as_secs_f64() * 1000.0),
    );
    Ok(point_count)
}

fn build_disk_segmented_ball_tree_index(
    app: &AppHandle,
    window: &Window,
    catalog_epoch: i64,
    total_indexes: usize,
    selected_index_label: &str,
) -> AppResult<usize> {
    let started = Instant::now();
    let dir = disk_segmented_index_dir(app, "segmented-ball-tree")?;
    reset_directory(&dir)?;
    let conn = connect(app)?;
    let builder = NativeSegmentedBallTreeIndex::default();
    let mut segments = Vec::<NativeDiskSegmentRef>::new();
    let mut point_count = 0_usize;

    for_each_geo_point_batch(
        &conn,
        SEGMENTED_BALL_TREE_SEGMENT_LIMIT,
        |batch, processed_points| {
            let points = batch
                .iter()
                .filter_map(normalized_geo_index_point)
                .collect::<Vec<_>>();
            if let Some(segment) =
                builder.build_segment(format!("segment-{:06}", segments.len()), points, false)
            {
                let data = serde_json::to_vec(&segment).map_err(|error| error.to_string())?;
                fs::write(segment_file_path(&dir, &segment.id), &data)
                    .map_err(|error| error.to_string())?;
                let summary = summary_for_points(&segment.points);
                point_count += segment.point_count;
                segments.push(NativeDiskSegmentRef {
                    id: segment.id,
                    is_delta: false,
                    point_count: segment.point_count,
                    max_leaf_size: segment.max_leaf_size,
                    byte_len: data.len(),
                    summary,
                });
            }
            emit_geo_index_progress(
                window,
                GeoIndexBuildProgress {
                    phase: "building".to_string(),
                    point_count: processed_points,
                    built_indexes: 0,
                    total_indexes,
                    current_index_id: Some("segmented-ball-tree".to_string()),
                    current_index_label: Some(selected_index_label.to_string()),
                    current_index_processed_points: Some(processed_points),
                    current_index_total_points: None,
                },
            );
            Ok(())
        },
    )?;

    let manifest = NativeDiskSegmentedManifest {
        engine_id: "segmented-ball-tree".to_string(),
        engine_version: 2,
        catalog_epoch,
        point_count,
        segment_count: segments.len(),
        created_at: current_timestamp_millis(),
        segments,
    };
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    registry.segmented_ball_tree.restore_disk_manifest(
        dir,
        manifest,
        Some(started.elapsed().as_secs_f64() * 1000.0),
    );
    Ok(point_count)
}

fn catalog_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_dir(app)?.join("catalog-v9.sqlite3"))
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
        CREATE TABLE IF NOT EXISTS media_assets (
          content_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          duration_ms INTEGER,
          timestamp INTEGER,
          latitude REAL,
          longitude REAL,
          thumbnail_key TEXT
        );

        CREATE TABLE IF NOT EXISTS media_locations (
          id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_label TEXT NOT NULL,
          root_path TEXT,
          relative_path TEXT,
          point_index INTEGER
        );

        CREATE TABLE IF NOT EXISTS catalog_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
          ON media_locations(content_hash);

        CREATE INDEX IF NOT EXISTS idx_assets_timestamp_hash
          ON media_assets(timestamp, content_hash);
        CREATE INDEX IF NOT EXISTS idx_assets_kind_timestamp_hash
          ON media_assets(kind, timestamp, content_hash);
        CREATE INDEX IF NOT EXISTS idx_assets_lat_lon_timestamp_hash
          ON media_assets(latitude, longitude, timestamp, content_hash);
        ",
    )
    .map_err(|error| error.to_string())
}

fn catalog_epoch(conn: &Connection) -> AppResult<i64> {
    let mut stmt = conn
        .prepare("SELECT value FROM catalog_metadata WHERE key = ?")
        .map_err(|error| error.to_string())?;
    let result = stmt.query_row([CATALOG_EPOCH_KEY], |row| row.get::<_, String>(0));
    match result {
        Ok(value) => Ok(value.parse::<i64>().unwrap_or(0)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(error) => Err(error.to_string()),
    }
}

fn bump_catalog_epoch(conn: &Connection) -> AppResult<i64> {
    let next_epoch = catalog_epoch(conn)? + 1;
    conn.execute(
        "
        INSERT INTO catalog_metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
        params![CATALOG_EPOCH_KEY, next_epoch.to_string()],
    )
    .map_err(|error| error.to_string())?;
    Ok(next_epoch)
}

fn sha256_string(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn geo_point_identity_input(latitude: f64, longitude: f64, timestamp: i64) -> String {
    format!("geo_point:v1:{latitude:.9}:{longitude:.9}:{timestamp}")
}

fn geo_point_content_hash(latitude: f64, longitude: f64, timestamp: i64) -> String {
    geo_point_identity_input(latitude, longitude, timestamp)
}

fn geo_point_location_id(source_id: &str, content_hash: &str) -> String {
    format!("geo_point_location:v1:{source_id}:{content_hash}")
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
        let timestamp = node
            .children()
            .find(|child| child.is_element() && child.tag_name().name() == "time")
            .and_then(|child| child.text())
            .and_then(parse_gpx_time);

        match (latitude, longitude, timestamp) {
            (Some(latitude), Some(longitude), Some(timestamp))
                if valid_latitude(latitude) && valid_longitude(longitude) =>
            {
                points.push(ParsedGeoPoint {
                    index,
                    latitude,
                    longitude,
                    timestamp,
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
                        let timestamp = parse_gpx_time(point.time_text.trim());
                        match (point.latitude, point.longitude, timestamp) {
                            (Some(latitude), Some(longitude), Some(timestamp))
                                if valid_latitude(latitude) && valid_longitude(longitude) =>
                            {
                                on_event(GpxStreamEvent::Point(
                                    ParsedGeoPoint {
                                        index: point.index,
                                        latitude,
                                        longitude,
                                        timestamp,
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
    let timestamp = entry
        .get("timestamp")
        .and_then(parse_json_timestamp)
        .or_else(|| entry.get("timestampMs").and_then(parse_json_timestamp_ms))
        .or_else(|| entry.get("timestampMS").and_then(parse_json_timestamp_ms));

    match (latitude, longitude, timestamp) {
        (Some(latitude), Some(longitude), Some(timestamp))
            if valid_latitude(latitude) && valid_longitude(longitude) =>
        {
            Some(ParsedGeoPoint {
                index,
                latitude,
                longitude,
                timestamp,
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

    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return metadata,
    };
    let mut reader = BufReader::new(file);
    let exif = match ExifReader::new().read_from_container(&mut reader) {
        Ok(exif) => exif,
        Err(_) => return metadata,
    };

    if metadata.timestamp.is_none() {
        for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
            if let Some(field) = exif.get_field(tag, In::PRIMARY) {
                if let Some(value) = exif_ascii(field).and_then(|value| parse_exif_date(&value)) {
                    metadata.timestamp = Some(value);
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
    source: &MediaSource,
    root: &Path,
    path: &Path,
) -> AppResult<Option<MediaItem>> {
    let kind = match detect_media_kind(path) {
        Some(kind) => kind,
        None => return Ok(None),
    };
    let relative_path = relative_path(root, path);
    let content_hash = file_hash(path)?;
    let location_id = sha256_string(&format!("{}\n{relative_path}", source.id));
    let display_name = display_name(path);
    let location = MediaLocation {
        id: location_id,
        source_id: source.id.clone(),
        source_label: source.label.clone(),
        root_path: source.root_path.clone(),
        relative_path: Some(relative_path.clone()),
        absolute_path: None,
        point_index: None,
    };
    let size_bytes = path
        .metadata()
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    let mut item = MediaItem {
        id: content_hash.clone(),
        content_hash: content_hash.clone(),
        source_id: source.id.clone(),
        relative_path,
        display_name,
        kind: kind.to_string(),
        mime_type: mime_type(path, kind),
        size_bytes,
        duration_ms: None,
        timestamp: modified_ms(path),
        latitude: None,
        longitude: None,
        thumbnail_key: None,
        locations: vec![location],
    };

    if kind == "image" {
        let metadata = read_image_metadata(path);
        item.timestamp = metadata.timestamp.or(item.timestamp);
        item.latitude = metadata.latitude;
        item.longitude = metadata.longitude;
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
        root_path: Some(absolute),
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
        root_path: Some(absolute),
    }
}

fn geo_point_item_from_parsed_point(
    source: &MediaSource,
    _absolute_path: &str,
    mime_type: &str,
    point: &ParsedGeoPoint,
) -> MediaItem {
    let content_hash = geo_point_content_hash(point.latitude, point.longitude, point.timestamp);
    let display_name = format!("{} #{}", source.label, point.index);
    let location = MediaLocation {
        id: geo_point_location_id(&source.id, &content_hash),
        source_id: source.id.clone(),
        source_label: source.label.clone(),
        root_path: source.root_path.clone(),
        relative_path: None,
        absolute_path: None,
        point_index: Some(point.index as i64),
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
        duration_ms: None,
        timestamp: Some(point.timestamp),
        latitude: Some(point.latitude),
        longitude: Some(point.longitude),
        thumbnail_key: None,
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
        duration_ms: row.get("duration_ms")?,
        timestamp: row.get("timestamp")?,
        latitude: row.get("latitude")?,
        longitude: row.get("longitude")?,
        thumbnail_key: row.get("thumbnail_key")?,
        locations: Vec::new(),
    })
}

fn location_from_row(row: &Row<'_>) -> rusqlite::Result<MediaLocation> {
    Ok(MediaLocation {
        id: row.get("id")?,
        source_id: row.get("source_id")?,
        source_label: row.get("source_label")?,
        root_path: row.get("root_path")?,
        relative_path: row.get("relative_path")?,
        absolute_path: None,
        point_index: row.get("point_index")?,
    })
}

fn derived_absolute_path(kind: &str, location: &MediaLocation) -> Option<String> {
    let root_path = location.root_path.as_ref()?;
    if kind == "geo_point" {
        return Some(root_path.clone());
    }
    let relative_path = location.relative_path.as_ref()?;
    Some(
        Path::new(root_path)
            .join(relative_path)
            .to_string_lossy()
            .to_string(),
    )
}

fn derived_relative_path(location: Option<&MediaLocation>) -> String {
    location
        .and_then(|location| location.relative_path.clone())
        .or_else(|| location.map(|location| location.source_label.clone()))
        .unwrap_or_default()
}

fn derived_display_name(
    kind: &str,
    content_hash: &str,
    location: Option<&MediaLocation>,
) -> String {
    if kind == "geo_point" {
        let base = location
            .map(|location| location.source_label.clone())
            .or_else(|| location.and_then(|location| location.relative_path.clone()))
            .unwrap_or_else(|| content_hash.to_string());
        return location
            .and_then(|location| location.point_index)
            .map(|index| format!("{base} #{index}"))
            .unwrap_or(base);
    }
    location
        .and_then(|location| location.relative_path.as_ref())
        .map(|path| display_name(Path::new(path)))
        .unwrap_or_else(|| content_hash.to_string())
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
        WHERE content_hash IN ({placeholders})
        ORDER BY relative_path ASC, id ASC
        "
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(hashes.iter()), |row| {
            Ok((
                row.get::<_, String>("content_hash")?,
                location_from_row(row)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut by_hash = HashMap::<String, Vec<MediaLocation>>::new();

    for row in rows {
        let (content_hash, location) = row.map_err(|error| error.to_string())?;
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
                    .then_with(|| a.id.cmp(&b.id))
            });
            let kind = item.kind.clone();
            for location in locations.iter_mut() {
                location.absolute_path = derived_absolute_path(&kind, location);
            }
            if let Some(primary) = locations.first() {
                item.source_id = primary.source_id.clone();
                item.relative_path = derived_relative_path(Some(primary));
                item.display_name = derived_display_name(&kind, &item.content_hash, Some(primary));
            }
            item.locations = locations;
            item
        })
        .collect())
}

fn upsert_source_tx(_conn: &Connection, _source: &MediaSource) -> AppResult<()> {
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
    conn: &Connection,
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
        conn.execute(&sql, params_from_iter(bind.iter()))
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
        value_optional_i64(item.duration_ms),
        value_optional_i64(item.timestamp),
        value_optional_f64(item.latitude),
        value_optional_f64(item.longitude),
        value_optional_text(&item.thumbnail_key),
    ]
}

fn location_rows(item: &MediaItem) -> Vec<Vec<Value>> {
    item.locations
        .iter()
        .map(|location| {
            vec![
                value_text(&location.id),
                value_text(&item.content_hash),
                value_text(&location.source_id),
                value_text(&location.source_label),
                value_optional_text(&location.root_path),
                value_optional_text(&location.relative_path),
                value_optional_i64(location.point_index),
            ]
        })
        .collect()
}

fn upsert_media_rows(conn: &mut Connection, items: &[MediaItem]) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }

    let asset_rows = items.iter().map(asset_row).collect::<Vec<_>>();
    exec_multi_row_upsert(
        conn,
        "
        INSERT INTO media_assets (
          content_hash, kind, mime_type, size_bytes, duration_ms,
          timestamp, latitude, longitude, thumbnail_key
        )
        ",
        "
        ON CONFLICT(content_hash) DO NOTHING
        ",
        &asset_rows,
        ASSET_BIND_COLUMNS,
    )?;

    let location_rows = items.iter().flat_map(location_rows).collect::<Vec<_>>();
    exec_multi_row_upsert(
        conn,
        "
        INSERT INTO media_locations (
          id, content_hash, source_id, source_label, root_path, relative_path,
          point_index
        )
        ",
        "
        ON CONFLICT(id) DO NOTHING
        ",
        &location_rows,
        LOCATION_BIND_COLUMNS,
    )?;
    bump_catalog_epoch(conn)?;
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
    upsert_media_rows(&mut conn, &items)
}

#[tauri::command]
fn list_media(app: AppHandle, query: CatalogQuery) -> AppResult<Vec<MediaItem>> {
    Ok(list_media_with_plan(app, query, false)?.0)
}

fn explain_query_plan(conn: &Connection, sql: &str, bind: &[Value]) -> AppResult<SqlExplainPlan> {
    let explain_sql = format!("EXPLAIN QUERY PLAN {sql}");
    let mut stmt = conn
        .prepare(&explain_sql)
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(bind.iter()), |row| {
            Ok(SqlExplainPlanRow {
                id: row.get(0)?,
                parent: row.get(1)?,
                detail: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut plan_rows = Vec::new();
    for row in rows {
        plan_rows.push(row.map_err(|error| error.to_string())?);
    }
    let details = plan_rows
        .iter()
        .map(|row| row.detail.clone())
        .collect::<Vec<_>>();
    Ok(SqlExplainPlan {
        rows: plan_rows,
        used_indexes: extract_sqlite_used_indexes(&details),
    })
}

fn list_media_with_plan(
    app: AppHandle,
    query: CatalogQuery,
    explain_sql: bool,
) -> AppResult<(Vec<MediaItem>, Option<SqlExplainPlan>)> {
    let conn = connect(&app)?;
    let mut where_sql = vec![
        "EXISTS (SELECT 1 FROM media_locations l WHERE l.content_hash = a.content_hash)"
            .to_string(),
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
            "EXISTS (SELECT 1 FROM media_locations ls WHERE ls.content_hash = a.content_hash AND ls.source_id = ?)".to_string(),
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
        where_sql.push("a.timestamp >= ?".to_string());
        bind.push(Value::Integer(start_time));
    }
    if let Some(end_time) = query.end_time {
        where_sql.push("a.timestamp <= ?".to_string());
        bind.push(Value::Integer(end_time));
    }

    where_sql.push("a.timestamp IS NOT NULL".to_string());
    let order = if query.sort == "timestamp_asc" {
        "a.timestamp ASC, a.content_hash ASC"
    } else {
        "a.timestamp DESC, a.content_hash DESC"
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
    let sql_plan = if explain_sql {
        Some(explain_query_plan(&conn, &sql, &bind)?)
    } else {
        None
    };
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(bind.iter()), asset_from_row)
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }

    Ok((
        attach_locations(&conn, items, query.source_id.as_deref())?,
        sql_plan,
    ))
}

fn sql_search_engine(spec: &SearchSpec) -> (&'static str, &'static str) {
    if spec.geo_bounds.is_some() {
        ("sqlite-bbox-time", "SQLite bbox/time B-tree")
    } else {
        ("sqlite-timestamp", "SQLite timestamp B-tree")
    }
}

fn search_spec_to_catalog_query(spec: &SearchSpec, limit: i64) -> CatalogQuery {
    CatalogQuery {
        kind: spec.kind.clone(),
        source_id: spec.source_id.clone(),
        has_geo: spec.has_geo,
        geo_bounds: spec.geo_bounds.clone(),
        sort: spec
            .order
            .sort
            .clone()
            .unwrap_or_else(|| "timestamp_desc".to_string()),
        limit: Some(limit),
        offset: spec.offset,
        start_time: spec.start_time,
        end_time: spec.end_time,
    }
}

fn media_items_to_search_rows(items: Vec<MediaItem>) -> Vec<SearchResultRow> {
    items
        .into_iter()
        .map(|item| SearchResultRow {
            media_id: item.id.clone(),
            distance_meters: None,
            item,
        })
        .collect()
}

fn enriched_distance_rows(
    items: Vec<MediaItem>,
    results: Vec<GeoSearchResult>,
) -> Vec<SearchResultRow> {
    let by_id = items
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();

    results
        .into_iter()
        .filter_map(|result| {
            by_id
                .get(&result.media_id)
                .cloned()
                .map(|item| SearchResultRow {
                    media_id: result.media_id,
                    distance_meters: Some(result.distance_meters),
                    item,
                })
        })
        .collect()
}

#[tauri::command]
fn search_media(app: AppHandle, spec: SearchSpec) -> AppResult<SearchPage> {
    let started_at = Instant::now();
    let limit = spec.limit.unwrap_or(500).clamp(1, 10_000);
    let offset = spec.offset.unwrap_or(0).max(0);

    if spec.order.kind == "distance" {
        let point = spec
            .order
            .point
            .as_ref()
            .ok_or_else(|| "Distance search requires a query point.".to_string())?;
        let engine_id = spec
            .order
            .engine_id
            .clone()
            .unwrap_or_else(|| "dynamic-z-order-cells".to_string());
        let query = GeoSearchQuery {
            lat: point.lat,
            lon: point.lon,
            k: limit,
            offset: spec.offset,
            kind: spec.kind.clone(),
            geo_bounds: spec.geo_bounds.clone(),
            start_time: spec.start_time,
            end_time: spec.end_time,
        };
        let results = search_geo_index(engine_id.clone(), query)?;
        let ids = results
            .iter()
            .map(|result| result.media_id.clone())
            .collect::<Vec<_>>();
        let items = get_media_by_ids(app, ids)?;
        let geo_stats = get_geo_index_stats(engine_id.clone())?;
        let (engine_label, exact, persistent) = match engine_id.as_str() {
            "brute-force" => ("Brute force oracle", true, false),
            "segmented-kd-tree" => ("Segmented KD-tree", true, true),
            "segmented-ball-tree" => ("Segmented ball tree", true, true),
            _ => ("Dynamic Z-order cells", true, true),
        };
        let rows = enriched_distance_rows(items, results);
        let limit_reached = (offset + limit) < geo_stats.point_count as i64;
        let result_metrics = with_query_metrics(
            search_stats_from_geo(geo_stats, engine_label, exact, persistent),
            &spec,
            "native",
            started_at.elapsed().as_secs_f64() * 1000.0,
            rows.len(),
            limit,
            offset,
            limit_reached,
            None,
        );

        return Ok(SearchPage {
            items: rows,
            result_metrics,
            engine_id,
            engine_label: engine_label.to_string(),
            limit_reached: Some(limit_reached),
        });
    }

    let (engine_id, engine_label) = sql_search_engine(&spec);
    let (rows, sql_plan) = list_media_with_plan(
        app,
        search_spec_to_catalog_query(&spec, limit.saturating_add(1)),
        spec.diagnostics
            .as_ref()
            .and_then(|diagnostics| diagnostics.explain_sql)
            .unwrap_or(false),
    )?;
    let limit_reached = rows.len() > limit as usize;
    let items = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let rows_returned = items.len();

    Ok(SearchPage {
        items: media_items_to_search_rows(items),
        result_metrics: with_query_metrics(
            empty_search_index_stats(engine_id, engine_label),
            &spec,
            "native",
            started_at.elapsed().as_secs_f64() * 1000.0,
            rows_returned,
            limit,
            offset,
            limit_reached,
            sql_plan,
        ),
        engine_id: engine_id.to_string(),
        engine_label: engine_label.to_string(),
        limit_reached: Some(limit_reached),
    })
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
        "a.latitude IS NOT NULL".to_string(),
        "a.longitude IS NOT NULL".to_string(),
        "EXISTS (SELECT 1 FROM media_locations l WHERE l.content_hash = a.content_hash)"
            .to_string(),
    ];
    let mut bind = Vec::<Value>::new();

    if let Some(start_time) = range.start_time {
        where_sql.push("a.timestamp >= ?".to_string());
        bind.push(Value::Integer(start_time));
    }
    if let Some(end_time) = range.end_time {
        where_sql.push("a.timestamp <= ?".to_string());
        bind.push(Value::Integer(end_time));
    }

    let sql = format!(
        "
        SELECT a.content_hash, a.kind, a.latitude, a.longitude, a.timestamp
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
                timestamp: row.get("timestamp")?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut points = Vec::new();
    for row in rows {
        points.push(row.map_err(|error| error.to_string())?);
    }
    Ok(points)
}

fn for_each_geo_point_batch(
    conn: &Connection,
    batch_size: usize,
    mut on_batch: impl FnMut(Vec<GeoIndexPoint>, usize) -> AppResult<()>,
) -> AppResult<usize> {
    let mut last_hash = String::new();
    let mut processed = 0_usize;

    loop {
        let mut stmt = conn
            .prepare(
                "
                SELECT a.content_hash, a.kind, a.latitude, a.longitude, a.timestamp
                FROM media_assets a
                WHERE a.content_hash > ?
                  AND a.latitude IS NOT NULL
                  AND a.longitude IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM media_locations l
                    WHERE l.content_hash = a.content_hash
                  )
                ORDER BY a.content_hash ASC
                LIMIT ?
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![last_hash, batch_size as i64], |row| {
                Ok(GeoIndexPoint {
                    media_id: row.get("content_hash")?,
                    kind: row.get("kind")?,
                    lat: row.get("latitude")?,
                    lon: row.get("longitude")?,
                    timestamp: row.get("timestamp")?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut batch = Vec::new();
        for row in rows {
            batch.push(row.map_err(|error| error.to_string())?);
        }
        if batch.is_empty() {
            break;
        }
        processed += batch.len();
        last_hash = batch
            .last()
            .map(|point| point.media_id.clone())
            .unwrap_or(last_hash);
        let is_final = batch.len() < batch_size;
        on_batch(batch, processed)?;
        if is_final {
            break;
        }
    }

    Ok(processed)
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
fn build_search_indexes(
    app: AppHandle,
    window: Window,
    index_id: String,
    force_rebuild: Option<bool>,
) -> AppResult<SearchIndexBuildSummary> {
    let started = Instant::now();
    let total_indexes = 1_usize;
    let selected_index_id = match index_id.as_str() {
        "brute-force" => "brute-force",
        "segmented-kd-tree" => "segmented-kd-tree",
        "segmented-ball-tree" => "segmented-ball-tree",
        _ => "dynamic-z-order-cells",
    };
    let selected_index_label = match selected_index_id {
        "brute-force" => "Brute force oracle",
        "segmented-kd-tree" => "Segmented KD-tree",
        "segmented-ball-tree" => "Segmented ball tree",
        _ => "Dynamic Z-order cells",
    };
    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "loading".to_string(),
            point_count: 0,
            built_indexes: 0,
            total_indexes,
            current_index_id: Some(selected_index_id.to_string()),
            current_index_label: Some(selected_index_label.to_string()),
            current_index_processed_points: None,
            current_index_total_points: None,
        },
    );

    let epoch = if selected_index_id == "dynamic-z-order-cells"
        || selected_index_id == "segmented-kd-tree"
        || selected_index_id == "segmented-ball-tree"
    {
        let conn = connect(&app)?;
        Some(catalog_epoch(&conn)?)
    } else {
        None
    };
    if let Some(epoch) = epoch {
        let should_restore = !force_rebuild.unwrap_or(false);
        let restored = match selected_index_id {
            "segmented-kd-tree" => should_restore
                .then(|| load_persisted_segmented_kd_tree_index(&app, epoch))
                .transpose()?
                .flatten(),
            "segmented-ball-tree" => should_restore
                .then(|| load_persisted_segmented_ball_tree_index(&app, epoch))
                .transpose()?
                .flatten(),
            _ => should_restore
                .then(|| load_persisted_dynamic_index(&app, epoch))
                .transpose()?
                .flatten(),
        };
        if let Some((point_count, _unit_count)) = restored {
            emit_geo_index_progress(
                &window,
                GeoIndexBuildProgress {
                    phase: "ready".to_string(),
                    point_count,
                    built_indexes: total_indexes,
                    total_indexes,
                    current_index_id: Some(selected_index_id.to_string()),
                    current_index_label: Some(selected_index_label.to_string()),
                    current_index_processed_points: Some(point_count),
                    current_index_total_points: Some(point_count),
                },
            );
            return Ok(SearchIndexBuildSummary {
                point_count,
                build_time_ms: started.elapsed().as_secs_f64() * 1000.0,
                engine_count: 6,
            });
        }
    }

    if let Some(epoch) = epoch {
        if selected_index_id == "segmented-kd-tree" {
            let point_count = build_disk_segmented_kd_tree_index(
                &app,
                &window,
                epoch,
                total_indexes,
                selected_index_label,
            )?;
            emit_geo_index_progress(
                &window,
                GeoIndexBuildProgress {
                    phase: "ready".to_string(),
                    point_count,
                    built_indexes: total_indexes,
                    total_indexes,
                    current_index_id: Some(selected_index_id.to_string()),
                    current_index_label: Some(selected_index_label.to_string()),
                    current_index_processed_points: Some(point_count),
                    current_index_total_points: Some(point_count),
                },
            );
            return Ok(SearchIndexBuildSummary {
                point_count,
                build_time_ms: started.elapsed().as_secs_f64() * 1000.0,
                engine_count: 6,
            });
        }
        if selected_index_id == "segmented-ball-tree" {
            let point_count = build_disk_segmented_ball_tree_index(
                &app,
                &window,
                epoch,
                total_indexes,
                selected_index_label,
            )?;
            emit_geo_index_progress(
                &window,
                GeoIndexBuildProgress {
                    phase: "ready".to_string(),
                    point_count,
                    built_indexes: total_indexes,
                    total_indexes,
                    current_index_id: Some(selected_index_id.to_string()),
                    current_index_label: Some(selected_index_label.to_string()),
                    current_index_processed_points: Some(point_count),
                    current_index_total_points: Some(point_count),
                },
            );
            return Ok(SearchIndexBuildSummary {
                point_count,
                build_time_ms: started.elapsed().as_secs_f64() * 1000.0,
                engine_count: 6,
            });
        }
    }

    let points = get_geo_points(
        app.clone(),
        TimeRange {
            start_time: None,
            end_time: None,
        },
    )?;
    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "building".to_string(),
            point_count: points.len(),
            built_indexes: 0,
            total_indexes,
            current_index_id: Some(selected_index_id.to_string()),
            current_index_label: Some(selected_index_label.to_string()),
            current_index_processed_points: Some(0),
            current_index_total_points: Some(points.len()),
        },
    );

    {
        let mut registry = geo_index_registry()
            .lock()
            .map_err(|error| error.to_string())?;
        if selected_index_id == "brute-force" {
            registry.brute_force.build(&points);
        } else if selected_index_id == "segmented-kd-tree" {
            registry
                .segmented_kd_tree
                .build(&points, |processed_points| {
                    emit_geo_index_progress(
                        &window,
                        GeoIndexBuildProgress {
                            phase: "building".to_string(),
                            point_count: points.len(),
                            built_indexes: 0,
                            total_indexes,
                            current_index_id: Some(selected_index_id.to_string()),
                            current_index_label: Some(selected_index_label.to_string()),
                            current_index_processed_points: Some(processed_points),
                            current_index_total_points: Some(points.len()),
                        },
                    );
                    Ok(())
                })?;
        } else if selected_index_id == "segmented-ball-tree" {
            registry
                .segmented_ball_tree
                .build(&points, |processed_points| {
                    emit_geo_index_progress(
                        &window,
                        GeoIndexBuildProgress {
                            phase: "building".to_string(),
                            point_count: points.len(),
                            built_indexes: 0,
                            total_indexes,
                            current_index_id: Some(selected_index_id.to_string()),
                            current_index_label: Some(selected_index_label.to_string()),
                            current_index_processed_points: Some(processed_points),
                            current_index_total_points: Some(points.len()),
                        },
                    );
                    Ok(())
                })?;
        } else {
            registry
                .dynamic_z_order
                .build(&points, |processed_points| {
                    emit_geo_index_progress(
                        &window,
                        GeoIndexBuildProgress {
                            phase: "building".to_string(),
                            point_count: points.len(),
                            built_indexes: 0,
                            total_indexes,
                            current_index_id: Some(selected_index_id.to_string()),
                            current_index_label: Some(selected_index_label.to_string()),
                            current_index_processed_points: Some(processed_points),
                            current_index_total_points: Some(points.len()),
                        },
                    );
                    Ok(())
                })?;
        }
    }

    if let Some(epoch) = epoch {
        let _ = match selected_index_id {
            "segmented-kd-tree" => save_persisted_segmented_kd_tree_index(&app, epoch),
            "segmented-ball-tree" => save_persisted_segmented_ball_tree_index(&app, epoch),
            _ => save_persisted_dynamic_index(&app, epoch),
        };
    }
    let summary = GeoIndexBuildSummary {
        point_count: points.len(),
        build_time_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    emit_geo_index_progress(
        &window,
        GeoIndexBuildProgress {
            phase: "ready".to_string(),
            point_count: points.len(),
            built_indexes: total_indexes,
            total_indexes,
            current_index_id: Some(selected_index_id.to_string()),
            current_index_label: Some(selected_index_label.to_string()),
            current_index_processed_points: Some(points.len()),
            current_index_total_points: Some(points.len()),
        },
    );

    Ok(SearchIndexBuildSummary {
        point_count: summary.point_count,
        build_time_ms: summary.build_time_ms,
        engine_count: 6,
    })
}

#[tauri::command]
fn search_geo_index(index_id: String, query: GeoSearchQuery) -> AppResult<Vec<GeoSearchResult>> {
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let results = match index_id.as_str() {
        "dynamic-z-order-cells" => registry.dynamic_z_order.search(&query),
        "segmented-kd-tree" => registry.segmented_kd_tree.search(&query),
        "segmented-ball-tree" => registry.segmented_ball_tree.search(&query),
        _ => registry.brute_force.search(&query),
    };
    Ok(results)
}

#[tauri::command]
fn get_geo_index_stats(index_id: String) -> AppResult<GeoIndexStats> {
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(match index_id.as_str() {
        "dynamic-z-order-cells" => registry.dynamic_z_order.last_stats.clone(),
        "segmented-kd-tree" => registry.segmented_kd_tree.last_stats.clone(),
        "segmented-ball-tree" => registry.segmented_ball_tree.last_stats.clone(),
        _ => registry.brute_force.last_stats.clone(),
    })
}

#[tauri::command]
fn get_search_index_stats() -> AppResult<Vec<SearchIndexStats>> {
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(vec![
        empty_search_index_stats("sqlite-timestamp", "SQLite timestamp B-tree"),
        empty_search_index_stats("sqlite-bbox-time", "SQLite bbox/time B-tree"),
        search_stats_from_geo(
            registry.brute_force.last_stats.clone(),
            "Brute force oracle",
            true,
            false,
        ),
        search_stats_from_geo(
            registry.dynamic_z_order.last_stats.clone(),
            "Dynamic Z-order cells",
            true,
            true,
        ),
        search_stats_from_geo(
            registry.segmented_kd_tree.last_stats.clone(),
            "Segmented KD-tree",
            true,
            true,
        ),
        search_stats_from_geo(
            registry.segmented_ball_tree.last_stats.clone(),
            "Segmented ball tree",
            true,
            true,
        ),
    ])
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
    let actual = match index_id.as_str() {
        "segmented-kd-tree" => registry.segmented_kd_tree.search(&query),
        "segmented-ball-tree" => registry.segmented_ball_tree.search(&query),
        _ => registry.dynamic_z_order.search(&query),
    };
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
        .prepare(
            "
            SELECT source_id, source_label, root_path
            FROM media_locations
            GROUP BY source_id, source_label, root_path
            ORDER BY source_label ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MediaSource {
                id: row.get("source_id")?,
                label: row.get("source_label")?,
                root_path: row.get("root_path")?,
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
    bump_catalog_epoch(&conn)?;
    Ok(())
}

#[tauri::command]
fn count_media(app: AppHandle) -> AppResult<i64> {
    let conn = connect(&app)?;
    conn.query_row(
        "
        SELECT COUNT(*)
        FROM media_assets a
        WHERE EXISTS (
            SELECT 1 FROM media_locations l
            WHERE l.content_hash = a.content_hash
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
        ",
    )
    .map_err(|error| error.to_string())?;
    bump_catalog_epoch(&conn)?;
    Ok(())
}

fn emit_progress(window: &Window, progress: ImportProgress) {
    let _ = window.emit("import-progress", progress);
}

fn reset_import_cancel() {
    IMPORT_CANCELLED.store(false, Ordering::SeqCst);
    IMPORT_COMMIT_REQUESTED.store(false, Ordering::SeqCst);
}

fn request_import_cancel() {
    IMPORT_CANCELLED.store(true, Ordering::SeqCst);
}

fn request_import_commit() {
    IMPORT_COMMIT_REQUESTED.store(true, Ordering::SeqCst);
}

fn take_import_commit_requested() -> bool {
    IMPORT_COMMIT_REQUESTED.swap(false, Ordering::SeqCst)
}

fn import_cancelled() -> bool {
    IMPORT_CANCELLED.load(Ordering::SeqCst)
}

#[tauri::command]
fn cancel_import() {
    request_import_cancel();
}

#[tauri::command]
fn commit_import() {
    request_import_commit();
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
    let written = upsert_media_rows(conn, batch)?;
    batch.clear();
    Ok(written)
}

fn begin_geo_import_transaction(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())
}

fn commit_geo_import_transaction(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("COMMIT")
        .map_err(|error| error.to_string())
}

fn rollback_geo_import_transaction(conn: &Connection) {
    let _ = conn.execute_batch("ROLLBACK");
}

fn flush_and_commit_geo_import_if_requested(
    conn: &mut Connection,
    batch: &mut Vec<MediaItem>,
) -> AppResult<()> {
    if !take_import_commit_requested() {
        return Ok(());
    }
    flush_media_batch(conn, batch)?;
    conn.execute_batch("COMMIT; BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())
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
) -> AppResult<(i64, i64, bool)> {
    let source_label = source.label.clone();
    let mut file = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let mut parser = GoogleTakeoutLocationStreamParser::new();
    let mut read_buffer = [0_u8; 256 * 1024];
    let mut batch = Vec::<MediaItem>::new();
    let mut accepted_media = 0_i64;
    let mut scanned_bytes = 0_i64;
    let mut last_progress = Instant::now() - std::time::Duration::from_millis(1000);
    let mut cancelled = false;

    loop {
        if import_cancelled() {
            cancelled = true;
            break;
        }
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
            if import_cancelled() {
                cancelled = true;
                break;
            }
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
                flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
                if import_cancelled() {
                    cancelled = true;
                    break;
                }
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
        if cancelled {
            break;
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
        flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
    }

    if !cancelled {
        parser.finish()?;
    }
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
    flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
    Ok((accepted_media, parser.skipped_points, cancelled))
}

fn import_gpx_streaming(
    path: &Path,
    source: &MediaSource,
    absolute_path: &str,
    total_bytes: i64,
    conn: &mut Connection,
    window: &Window,
) -> AppResult<(i64, i64, bool)> {
    let source_label = source.label.clone();
    let mut batch = Vec::<MediaItem>::new();
    let mut accepted_media = 0_i64;
    let mut skipped_files = 0_i64;
    let mut last_progress = Instant::now() - std::time::Duration::from_millis(1000);
    let mut cancelled = false;

    let stream_result = stream_gpx_points(path, |event| {
        if import_cancelled() {
            cancelled = true;
            return Err("Import cancelled".to_string());
        }
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
                    flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
                    if import_cancelled() {
                        cancelled = true;
                        return Err("Import cancelled".to_string());
                    }
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
                flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
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
                flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
            }
        }
        Ok(())
    });

    match stream_result {
        Ok(final_skipped) => {
            skipped_files = final_skipped;
        }
        Err(error) if cancelled || error == "Import cancelled" => {
            cancelled = true;
        }
        Err(error) => return Err(error),
    }
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
    flush_and_commit_geo_import_if_requested(conn, &mut batch)?;
    Ok((accepted_media, skipped_files, cancelled))
}

#[tauri::command]
fn import_folder(app: AppHandle, window: Window) -> AppResult<ImportSummary> {
    let Some(root) = rfd::FileDialog::new().pick_folder() else {
        return Err("Import cancelled".to_string());
    };
    reset_import_cancel();
    let root = root.canonicalize().unwrap_or(root);
    let source = source_from_root(&root);
    let source_label = source.label.clone();

    let mut total_files = 0_i64;
    let mut cancelled = false;
    for entry in WalkDir::new(&root).follow_links(false).into_iter() {
        if import_cancelled() {
            cancelled = true;
            break;
        }
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

    if !cancelled {
        for entry in WalkDir::new(&root).follow_links(false).into_iter() {
            if import_cancelled() {
                cancelled = true;
                break;
            }
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

            match media_from_path(&app, &source, &root, &path) {
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
                        if import_cancelled() {
                            cancelled = true;
                            break;
                        }
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
        cancelled: cancelled.then_some(true),
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
    reset_import_cancel();
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
    let (accepted_media, skipped_files, cancelled) = if import_cancelled() {
        (0, 0, true)
    } else {
        begin_geo_import_transaction(&conn)?;
        let result = match format {
            GeoFileFormat::GoogleTakeoutJson => import_google_takeout_streaming(
                &path,
                &source,
                &absolute_path,
                total_bytes,
                &mut conn,
                &window,
            ),
            GeoFileFormat::Gpx => import_gpx_streaming(
                &path,
                &source,
                &absolute_path,
                total_bytes,
                &mut conn,
                &window,
            ),
        };
        match result {
            Ok(summary) => {
                commit_geo_import_transaction(&conn)?;
                summary
            }
            Err(error) => {
                rollback_geo_import_transaction(&conn);
                return Err(error);
            }
        }
    };

    Ok(ImportSummary {
        source,
        source_label,
        scanned_files: 1,
        total_files: 1,
        accepted_media,
        skipped_files,
        errors: Vec::new(),
        cancelled: cancelled.then_some(true),
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
            search_media,
            get_media_by_ids,
            get_geo_points,
            build_geo_indexes,
            build_search_indexes,
            search_geo_index,
            get_geo_index_stats,
            get_search_index_stats,
            validate_geo_index,
            list_sources,
            remove_sources,
            count_media,
            clear_catalog,
            cancel_import,
            commit_import,
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
            duration_ms: None,
            timestamp: Some(1_700_000_000_000),
            latitude: Some(47.0),
            longitude: Some(8.0),
            thumbnail_key: Some(format!("thumbs/{content_hash}.webp")),
            locations: vec![MediaLocation {
                id: location_id,
                source_id: source_id.to_string(),
                source_label: source_id.to_string(),
                root_path: Some("/tmp/source".to_string()),
                relative_path: Some(path.to_string()),
                absolute_path: None,
                point_index: None,
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
    fn extracts_sqlite_index_names_from_explain_details() {
        assert_eq!(
            extract_sqlite_used_indexes(&[
                "SEARCH a USING COVERING INDEX idx_assets_kind_timestamp_hash (kind=?)".to_string(),
                "SEARCH l USING INDEX idx_locations_content_hash (content_hash=?)".to_string(),
                "SCAN media_assets".to_string(),
            ]),
            vec![
                "idx_assets_kind_timestamp_hash".to_string(),
                "idx_locations_content_hash".to_string(),
            ]
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
            "geo_point:v1:48.123456789:11.987654321:1782036930123"
        );
        assert_eq!(
            geo_point_content_hash(48.1234567894, 11.9876543214, 1_782_036_930_123),
            "geo_point:v1:48.123456789:11.987654321:1782036930123"
        );
    }

    fn test_geo_points() -> Vec<GeoIndexPoint> {
        vec![
            GeoIndexPoint {
                media_id: "a".to_string(),
                kind: Some("geo_point".to_string()),
                lat: 48.1,
                lon: 11.5,
                timestamp: Some(1_000),
            },
            GeoIndexPoint {
                media_id: "b".to_string(),
                kind: Some("image".to_string()),
                lat: 48.2,
                lon: 11.6,
                timestamp: Some(2_000),
            },
            GeoIndexPoint {
                media_id: "c".to_string(),
                kind: Some("video".to_string()),
                lat: 49.0,
                lon: 12.0,
                timestamp: Some(3_000),
            },
        ]
    }

    fn test_disk_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zeitfaden-{name}-{}", current_timestamp_millis()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn disk_manifest_for_segment(
        engine_id: &str,
        segment_id: &str,
        points: &[GeoIndexPoint],
        byte_len: usize,
        max_leaf_size: usize,
    ) -> NativeDiskSegmentedManifest {
        NativeDiskSegmentedManifest {
            engine_id: engine_id.to_string(),
            engine_version: 2,
            catalog_epoch: 7,
            point_count: points.len(),
            segment_count: 1,
            created_at: current_timestamp_millis(),
            segments: vec![NativeDiskSegmentRef {
                id: segment_id.to_string(),
                is_delta: false,
                point_count: points.len(),
                max_leaf_size,
                byte_len,
                summary: summary_for_points(points),
            }],
        }
    }

    #[test]
    fn native_dynamic_index_binary_round_trips_search_results() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut fresh = NativeDynamicZOrderIndex::default();
        fresh.build(&points, |_| Ok(())).unwrap();
        let expected = fresh.search(&query);

        let encoded = encode_dynamic_index(&fresh).unwrap();
        let mut restored = decode_dynamic_index(&encoded).unwrap();

        assert_eq!(
            restored
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn native_dynamic_index_rejects_corrupt_binary_data() {
        let points = test_geo_points();
        let mut index = NativeDynamicZOrderIndex::default();
        index.build(&points, |_| Ok(())).unwrap();
        let mut encoded = encode_dynamic_index(&index).unwrap();
        encoded[0] = 0;

        assert!(decode_dynamic_index(&encoded).is_err());
    }

    #[test]
    fn native_segmented_kd_tree_matches_brute_force() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut oracle = NativeBruteForceIndex::default();
        oracle.build(&points);
        let expected = oracle.search(&query);

        let mut index = NativeSegmentedKdTreeIndex::default();
        index.build(&points, |_| Ok(())).unwrap();

        assert_eq!(
            index
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn native_segmented_kd_tree_snapshot_round_trips_search_results() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut fresh = NativeSegmentedKdTreeIndex::default();
        fresh.build(&points, |_| Ok(())).unwrap();
        let expected = fresh.search(&query);

        let snapshot = fresh.snapshot();
        let encoded = serde_json::to_vec(&snapshot).unwrap();
        let decoded = serde_json::from_slice::<NativeSegmentedKdTreeSnapshot>(&encoded).unwrap();
        let mut restored = NativeSegmentedKdTreeIndex::default();
        restored.restore(decoded).unwrap();

        assert_eq!(
            restored
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn native_segmented_kd_tree_disk_manifest_restores_without_loading_segments() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut oracle = NativeBruteForceIndex::default();
        oracle.build(&points);
        let expected = oracle.search(&query);

        let dir = test_disk_dir("kd-disk");
        let segment = NativeKdSegment {
            id: "segment-000000".to_string(),
            is_delta: false,
            points: points
                .iter()
                .filter_map(normalized_geo_index_point)
                .collect::<Vec<_>>(),
            max_leaf_size: SEGMENTED_KD_TREE_LEAF_SIZE,
        };
        let data = serde_json::to_vec(&segment).unwrap();
        fs::write(segment_file_path(&dir, &segment.id), &data).unwrap();
        let manifest = disk_manifest_for_segment(
            "segmented-kd-tree",
            &segment.id,
            &segment.points,
            data.len(),
            segment.max_leaf_size,
        );
        let mut restored = NativeSegmentedKdTreeIndex::default();
        restored.restore_disk_manifest(dir.clone(), manifest, Some(0.0));
        assert_eq!(restored.segment_cache.len(), 0);

        assert_eq!(
            restored
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(restored.last_stats.index_storage.as_deref(), Some("disk"));
        assert!(restored.last_stats.disk_read_count.unwrap_or(0) > 0);
        assert!(restored.last_stats.loaded_pages.unwrap_or(0) > 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_segmented_ball_tree_matches_brute_force() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut oracle = NativeBruteForceIndex::default();
        oracle.build(&points);
        let expected = oracle.search(&query);

        let mut index = NativeSegmentedBallTreeIndex::default();
        index.build(&points, |_| Ok(())).unwrap();

        assert_eq!(
            index
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn native_segmented_ball_tree_builds_duplicate_coordinate_clusters() {
        let points = (0..5_000)
            .map(|index| GeoIndexPoint {
                media_id: format!("duplicate-{index:05}"),
                kind: Some("geo_point".to_string()),
                lat: 48.137,
                lon: 11.576,
                timestamp: Some(index),
            })
            .collect::<Vec<_>>();
        let query = GeoSearchQuery {
            lat: 48.137,
            lon: 11.576,
            k: 5,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut index = NativeSegmentedBallTreeIndex::default();
        index.build(&points, |_| Ok(())).unwrap();

        assert_eq!(
            index
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "duplicate-00000",
                "duplicate-00001",
                "duplicate-00002",
                "duplicate-00003",
                "duplicate-00004",
            ]
        );
    }

    #[test]
    fn native_segmented_ball_tree_snapshot_round_trips_search_results() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut fresh = NativeSegmentedBallTreeIndex::default();
        fresh.build(&points, |_| Ok(())).unwrap();
        let expected = fresh.search(&query);

        let snapshot = fresh.snapshot();
        let encoded = serde_json::to_vec(&snapshot).unwrap();
        let decoded = serde_json::from_slice::<NativeSegmentedBallTreeSnapshot>(&encoded).unwrap();
        let mut restored = NativeSegmentedBallTreeIndex::default();
        restored.restore(decoded).unwrap();

        assert_eq!(
            restored
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn native_segmented_ball_tree_disk_manifest_restores_without_loading_segments() {
        let points = test_geo_points();
        let query = GeoSearchQuery {
            lat: 48.15,
            lon: 11.55,
            k: 10,
            offset: None,
            kind: None,
            geo_bounds: None,
            start_time: None,
            end_time: None,
        };
        let mut oracle = NativeBruteForceIndex::default();
        oracle.build(&points);
        let expected = oracle.search(&query);

        let dir = test_disk_dir("ball-disk");
        let builder = NativeSegmentedBallTreeIndex::default();
        let segment = builder
            .build_segment(
                "segment-000000".to_string(),
                points
                    .iter()
                    .filter_map(normalized_geo_index_point)
                    .collect::<Vec<_>>(),
                false,
            )
            .unwrap();
        let data = serde_json::to_vec(&segment).unwrap();
        fs::write(segment_file_path(&dir, &segment.id), &data).unwrap();
        let manifest = disk_manifest_for_segment(
            "segmented-ball-tree",
            &segment.id,
            &segment.points,
            data.len(),
            segment.max_leaf_size,
        );
        let mut restored = NativeSegmentedBallTreeIndex::default();
        restored.restore_disk_manifest(dir.clone(), manifest, Some(0.0));
        assert_eq!(restored.segment_cache.len(), 0);

        assert_eq!(
            restored
                .search(&query)
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|result| result.media_id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(restored.last_stats.index_storage.as_deref(), Some("disk"));
        assert!(restored.last_stats.disk_read_count.unwrap_or(0) > 0);
        assert!(restored.last_stats.loaded_pages.unwrap_or(0) > 0);
        let _ = fs::remove_dir_all(dir);
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
            parsed.points[0].timestamp,
            DateTime::parse_from_rfc3339("2012-10-28T14:21:22.010Z")
                .unwrap()
                .timestamp_millis()
        );
        assert_eq!(parsed.points[2].index, 4);
        assert_eq!(parsed.points[2].timestamp, 1_351_434_205_077);
        assert_eq!(parsed.points[3].index, 5);
        assert_eq!(parsed.points[3].timestamp, 1_351_434_206_077);
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
            root_path: Some("/tmp/track.gpx".to_string()),
        };
        let first = ParsedGeoPoint {
            index: 1,
            latitude: 48.1,
            longitude: 11.5,
            timestamp: 1_782_036_000_000,
        };
        let second = ParsedGeoPoint {
            index: 2,
            latitude: 48.2,
            longitude: 11.6,
            timestamp: 1_782_036_060_000,
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
        upsert_media_rows(&mut conn, &items).unwrap();
        upsert_media_rows(&mut conn, &items).unwrap();

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
    fn fresh_schema_has_two_tables_and_no_legacy_columns() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        let source_table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'media_sources'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let asset_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_assets'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let location_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_locations'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(source_table_count, 0);
        assert!(!asset_sql.contains("deleted_at"));
        assert!(!asset_sql.contains("last_seen_at"));
        assert!(!asset_sql.contains("timestamp_source"));
        assert!(!asset_sql.contains("geo_source"));
        assert!(!asset_sql.contains("width"));
        assert!(!asset_sql.contains("height"));
        assert!(!location_sql.contains("deleted_at"));
        assert!(!location_sql.contains("source_added_at"));
        assert!(!location_sql.contains("last_seen_at"));
        assert!(location_sql.contains("source_id"));
        assert!(location_sql.contains("source_label"));
        assert!(location_sql.contains("root_path"));
        assert!(location_sql.contains("point_index"));
    }

    #[test]
    fn upsert_keeps_one_asset_with_many_locations() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        let source = MediaSource {
            id: "source".to_string(),
            label: "Source".to_string(),
            root_path: Some("/tmp/source".to_string()),
        };
        upsert_source_tx(&conn, &source).unwrap();

        let first = test_item("same-hash", "source", "a/photo.jpg");
        let second = test_item("same-hash", "source", "b/photo-copy.jpg");
        upsert_media_rows(&mut conn, &[first.clone(), second]).unwrap();
        upsert_media_rows(&mut conn, &[first]).unwrap();

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
