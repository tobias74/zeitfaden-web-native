use chrono::{DateTime, NaiveDateTime};
use exif::{In, Reader as ExifReader, Tag, Value as ExifValue};
use image::ImageFormat;
use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader as XmlReader;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Window};
use walkdir::WalkDir;

type AppResult<T> = Result<T, String>;

const IMPORT_BATCH_SIZE: usize = 1000;
const GEO_IMPORT_PREFIX_BYTES: usize = 512 * 1024;
const PROGRESS_HEARTBEAT_MS: u128 = 1000;
const FILE_CATALOG_DIR: &str = "catalog-file-v1";
const FILE_CATALOG_MANIFEST: &str = "manifest.json";
const FILE_CATALOG_ASSETS: &str = "assets.bin";
const FILE_CATALOG_TIME_GEO_INDEX: &str = "time-geo.idx";
const ASSET_RECORD_INDEX_FILE: &str = "records.idx";
const ASSET_ID_MAP_FILE: &str = "ids.idx";
const ASSET_CHUNK_PREFIX: &str = "chunk-";
const ASSET_BINARY_CHUNK_EXTENSION: &str = ".bin";
const ASSET_TABLE_MAGIC: u32 = 0x4153_5431;
const ASSET_ID_MAP_MAGIC: u32 = 0x4149_4431;
const PACKED_INDEX_MAGIC: u32 = 0x5049_5831;
const BINARY_SCHEMA_VERSION: u32 = 3;
const ASSET_CHUNK_SIZE: usize = 10_000;
const ASSET_TABLE_HEADER_SIZE: usize = 32;
const ASSET_RECORD_INDEX_ENTRY_SIZE: usize = 16;
const ASSET_ID_MAP_HEADER_SIZE: usize = 32;
const ASSET_ID_MAP_ENTRY_SIZE: usize = 72;
const PACKED_INDEX_HEADER_SIZE: usize = 96;
const TIME_GEO_RECORD_SIZE: usize = 44;
const PACKED_SCAN_RECORDS: usize = 8192;
const MAX_RENDERED_MAP_BUBBLES: i64 = 5_000;
const WEB_MERCATOR_MAX_LAT: f64 = 85.051_128_779_806_6;
const WEB_MERCATOR_TILE_SIZE: f64 = 256.0;
const INDEX_KIND_TIME_GEO: u32 = 1;
const KIND_CODE_IMAGE: u8 = 0;
const KIND_CODE_VIDEO: u8 = 1;
const KIND_CODE_GEO_POINT: u8 = 2;
const KIND_CODE_TIMELINE_VISIT: u8 = 3;
const KIND_CODE_TIMELINE_ACTIVITY: u8 = 4;
const KIND_CODE_ACTIVITY_SAMPLE: u8 = 5;
const KIND_CODE_FREQUENT_PLACE: u8 = 6;
const KIND_CODE_MASK: u8 = 0x7f;
const KIND_FLAG_HAS_GEO: u8 = 1 << 7;
const LINE_SOURCE_UNKNOWN: u8 = 0;
const LINE_SOURCE_GPS: u8 = 1;
const LINE_SOURCE_WIFI: u8 = 2;
const LINE_SOURCE_CELL: u8 = 3;
const LINE_QUALITY_HAS_ACCURACY: u16 = 1 << 0;
const LINE_QUALITY_HAS_VELOCITY: u16 = 1 << 1;
const LINE_QUALITY_HAS_HEADING: u16 = 1 << 2;
const LINE_QUALITY_HAS_GROUP: u16 = 1 << 3;
const LINE_QUALITY_HAS_SEQUENCE: u16 = 1 << 4;
const SEGMENTED_BALL_TREE_SEGMENT_LIMIT: usize = 100_000;
const SEGMENTED_BALL_TREE_DELTA_LIMIT: usize = 50_000;
const SEGMENTED_BALL_TREE_LEAF_SIZE: usize = 64;
static IMPORT_CANCELLED: AtomicBool = AtomicBool::new(false);
static IMPORT_COMMIT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogInfo {
    storage_mode: String,
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
    source_dataset: Option<String>,
    source_type: Option<String>,
    group_id: Option<String>,
    sequence: Option<i64>,
    timestamp: Option<i64>,
    end_timestamp: Option<i64>,
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
    end_timestamp: Option<i64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    thumbnail_key: Option<String>,
    source_dataset: Option<String>,
    source_type: Option<String>,
    accuracy_meters: Option<f64>,
    altitude_meters: Option<f64>,
    vertical_accuracy_meters: Option<f64>,
    velocity_meters_per_second: Option<f64>,
    heading_degrees: Option<f64>,
    group_id: Option<String>,
    sequence: Option<i64>,
    metadata: Option<JsonValue>,
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
struct MapPoint {
    media_id: Option<String>,
    asset_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_id: Option<String>,
    kind: Option<String>,
    lat: f64,
    lon: f64,
    timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<GeoBounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPolylinePoint {
    lat: f64,
    lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPolylineSegment {
    points: Vec<MapPolylinePoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPolyline {
    points: Vec<MapPolylinePoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<MapPolylineSegment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<GeoBounds>,
    source_point_count: usize,
    simplified_point_count: usize,
    tolerance_px: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPointPage {
    points: Vec<MapPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    polyline: Option<MapPolyline>,
    limit_reached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_metrics: Option<SearchIndexStats>,
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
    index_status: Option<String>,
    catalog_version: Option<i64>,
    index_catalog_version: Option<i64>,
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
    cell_count: Option<usize>,
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
struct MapAggregationSpec {
    zoom: f64,
    viewport_width_px: f64,
    viewport_height_px: f64,
    bubble_cell_size_px: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPolylineSpec {
    tolerance_px: f64,
    max_points: usize,
    cleanup: Option<MapPolylineCleanupSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapPolylineCleanupSpec {
    enabled: bool,
    group_lines_only: bool,
    allowed_sources: Vec<String>,
    max_accuracy_meters: Option<f64>,
    break_speed_kmh: Option<f64>,
    max_segment_distance_km: Option<f64>,
    remove_isolated_jumps: bool,
    show_dots: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchSpec {
    kind: Option<String>,
    source_id: Option<String>,
    has_geo: Option<bool>,
    geo_bounds: Option<GeoBounds>,
    map_aggregation: Option<MapAggregationSpec>,
    map_mode: Option<String>,
    map_polyline: Option<MapPolylineSpec>,
    order: SearchOrder,
    limit: Option<i64>,
    offset: Option<i64>,
    purpose: String,
    start_time: Option<i64>,
    end_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchIndexStats {
    engine_id: String,
    engine_label: Option<String>,
    exact: Option<bool>,
    persistent: Option<bool>,
    point_count: usize,
    index_status: Option<String>,
    catalog_version: Option<i64>,
    index_catalog_version: Option<i64>,
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
    cell_count: Option<usize>,
    query_purpose: Option<String>,
    storage_mode: Option<String>,
    query_time_ms: Option<f64>,
    rows_returned: Option<usize>,
    matched_records: Option<usize>,
    rendered_bubbles: Option<usize>,
    largest_bubble_count: Option<usize>,
    source_line_points: Option<usize>,
    accepted_line_points: Option<usize>,
    filtered_line_points: Option<usize>,
    filtered_quality_points: Option<usize>,
    filtered_jump_points: Option<usize>,
    line_speed_breaks: Option<usize>,
    line_distance_breaks: Option<usize>,
    line_segments: Option<usize>,
    rendered_line_points: Option<usize>,
    rendered_line_dots: Option<usize>,
    simplification_tolerance_px: Option<f64>,
    aggregation_zoom: Option<usize>,
    aggregation_cell_size_px: Option<f64>,
    limit: Option<i64>,
    offset: Option<i64>,
    limit_reached: Option<bool>,
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
    kind: String,
    latitude: f64,
    longitude: f64,
    timestamp: i64,
    end_timestamp: Option<i64>,
    source_dataset: Option<String>,
    source_type: Option<String>,
    accuracy_meters: Option<f64>,
    altitude_meters: Option<f64>,
    vertical_accuracy_meters: Option<f64>,
    velocity_meters_per_second: Option<f64>,
    heading_degrees: Option<f64>,
    group_id: Option<String>,
    sequence: Option<i64>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedGeoItem {
    index: i64,
    kind: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    timestamp: Option<i64>,
    end_timestamp: Option<i64>,
    source_dataset: Option<String>,
    source_type: Option<String>,
    accuracy_meters: Option<f64>,
    altitude_meters: Option<f64>,
    vertical_accuracy_meters: Option<f64>,
    velocity_meters_per_second: Option<f64>,
    heading_degrees: Option<f64>,
    group_id: Option<String>,
    sequence: Option<i64>,
    content_hash: Option<String>,
    display_name: Option<String>,
    metadata: Option<JsonValue>,
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
    GoogleTimelineJson,
}

#[derive(Default)]
struct NativeMetadata {
    timestamp: Option<i64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Clone)]
struct NativeBruteForceIndex {
    points: Vec<GeoIndexPoint>,
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
    segmented_ball_tree: NativeSegmentedBallTreeIndex,
}

const EARTH_RADIUS_METERS: f64 = 6_371_008.8;
const DISTANCE_TIE_EPSILON_METERS: f64 = 1e-6;

static GEO_INDEX_REGISTRY: OnceLock<Mutex<NativeGeoIndexRegistry>> = OnceLock::new();

fn geo_index_registry() -> &'static Mutex<NativeGeoIndexRegistry> {
    GEO_INDEX_REGISTRY.get_or_init(|| Mutex::new(NativeGeoIndexRegistry::default()))
}

impl Default for NativeGeoIndexRegistry {
    fn default() -> Self {
        Self {
            brute_force: NativeBruteForceIndex::default(),
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
        index_status: None,
        catalog_version: None,
        index_catalog_version: None,
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
        cell_count: None,
    }
}

fn empty_search_index_stats(engine_id: &str, engine_label: &str) -> SearchIndexStats {
    SearchIndexStats {
        engine_id: engine_id.to_string(),
        engine_label: Some(engine_label.to_string()),
        exact: Some(true),
        persistent: Some(true),
        point_count: 0,
        index_status: None,
        catalog_version: None,
        index_catalog_version: None,
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
        cell_count: None,
        query_purpose: None,
        storage_mode: None,
        query_time_ms: None,
        rows_returned: None,
        matched_records: None,
        rendered_bubbles: None,
        largest_bubble_count: None,
        source_line_points: None,
        accepted_line_points: None,
        filtered_line_points: None,
        filtered_quality_points: None,
        filtered_jump_points: None,
        line_speed_breaks: None,
        line_distance_breaks: None,
        line_segments: None,
        rendered_line_points: None,
        rendered_line_dots: None,
        simplification_tolerance_px: None,
        aggregation_zoom: None,
        aggregation_cell_size_px: None,
        limit: None,
        offset: None,
        limit_reached: None,
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
        index_status: stats.index_status,
        catalog_version: stats.catalog_version,
        index_catalog_version: stats.index_catalog_version,
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
        cell_count: stats.cell_count,
        query_purpose: None,
        storage_mode: None,
        query_time_ms: None,
        rows_returned: None,
        matched_records: None,
        rendered_bubbles: None,
        largest_bubble_count: None,
        source_line_points: None,
        accepted_line_points: None,
        filtered_line_points: None,
        filtered_quality_points: None,
        filtered_jump_points: None,
        line_speed_breaks: None,
        line_distance_breaks: None,
        line_segments: None,
        rendered_line_points: None,
        rendered_line_dots: None,
        simplification_tolerance_px: None,
        aggregation_zoom: None,
        aggregation_cell_size_px: None,
        limit: None,
        offset: None,
        limit_reached: None,
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
    stats
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
    let builder = NativeSegmentedBallTreeIndex::default();
    let mut segments = Vec::<NativeDiskSegmentRef>::new();
    let mut point_count = 0_usize;

    for_each_geo_point_batch(
        app,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCatalogSource {
    id: String,
    label: String,
    root_path: Option<String>,
    generation: i64,
    active: bool,
    imported_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCatalogChunk {
    id: String,
    source_id: String,
    generation: i64,
    count: usize,
    created_at: i64,
    active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCatalogManifest {
    schema_version: i64,
    catalog_version: i64,
    #[serde(default)]
    next_asset_id: i64,
    #[serde(default = "minus_one_i64")]
    asset_store_version: i64,
    #[serde(default = "minus_one_i64")]
    index_applied_version: i64,
    #[serde(default)]
    index_job: Option<FileCatalogIndexJob>,
    next_chunk_id: i64,
    occurrence_count: usize,
    asset_count: usize,
    location_count: usize,
    materialized_version: i64,
    sources: HashMap<String, FileCatalogSource>,
    chunks: Vec<FileCatalogChunk>,
}

fn minus_one_i64() -> i64 {
    -1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCatalogIndexJob {
    status: String,
    pending_since: Option<i64>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    failed_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileOccurrence {
    item: MediaItem,
    source_id: String,
    generation: i64,
}

fn empty_file_catalog_manifest() -> FileCatalogManifest {
    FileCatalogManifest {
        schema_version: BINARY_SCHEMA_VERSION as i64,
        catalog_version: 0,
        next_asset_id: 0,
        asset_store_version: -1,
        index_applied_version: -1,
        index_job: Some(FileCatalogIndexJob {
            status: "current".to_string(),
            pending_since: None,
            started_at: None,
            finished_at: None,
            failed_message: None,
        }),
        next_chunk_id: 0,
        occurrence_count: 0,
        asset_count: 0,
        location_count: 0,
        materialized_version: -1,
        sources: HashMap::new(),
        chunks: Vec::new(),
    }
}

fn catalog_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_dir(app)?.join(FILE_CATALOG_DIR))
}

fn manifest_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(catalog_dir(app)?.join(FILE_CATALOG_MANIFEST))
}

fn occurrences_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(catalog_dir(app)?.join("occurrences"))
}

fn assets_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(catalog_dir(app)?.join("assets"))
}

fn catalog_indexes_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(catalog_dir(app)?.join("indexes"))
}

fn ensure_file_catalog_dirs(app: &AppHandle) -> AppResult<()> {
    fs::create_dir_all(occurrences_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(assets_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(catalog_indexes_dir(app)?).map_err(|error| error.to_string())?;
    Ok(())
}

fn load_file_catalog_manifest(app: &AppHandle) -> AppResult<FileCatalogManifest> {
    ensure_file_catalog_dirs(app)?;
    let path = manifest_path(app)?;
    if !path.exists() {
        return Ok(empty_file_catalog_manifest());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let manifest: FileCatalogManifest =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;
    if manifest.schema_version != BINARY_SCHEMA_VERSION as i64 {
        return Ok(empty_file_catalog_manifest());
    }
    Ok(manifest)
}

fn save_file_catalog_manifest(app: &AppHandle, manifest: &FileCatalogManifest) -> AppResult<()> {
    ensure_file_catalog_dirs(app)?;
    fs::write(
        manifest_path(app)?,
        serde_json::to_string(manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn catalog_epoch(app: &AppHandle) -> AppResult<i64> {
    Ok(load_file_catalog_manifest(app)?.catalog_version)
}

fn bump_catalog_epoch(app: &AppHandle, manifest: &mut FileCatalogManifest) -> AppResult<i64> {
    manifest.catalog_version += 1;
    manifest.materialized_version = -1;
    manifest.asset_store_version = -1;
    manifest.index_job = Some(FileCatalogIndexJob {
        status: "pending".to_string(),
        pending_since: Some(current_timestamp_millis()),
        started_at: None,
        finished_at: None,
        failed_message: None,
    });
    save_file_catalog_manifest(app, manifest)?;
    Ok(manifest.catalog_version)
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

fn geo_point_location_id(
    source_id: &str,
    content_hash: &str,
    source_dataset: Option<&str>,
    source_type: Option<&str>,
    group_id: Option<&str>,
    sequence: Option<i64>,
) -> String {
    format!(
        "geo_point_location:v2:{source_id}:{content_hash}:{}:{}:{}:{}",
        source_dataset.unwrap_or_default(),
        source_type.unwrap_or_default(),
        group_id.unwrap_or_default(),
        sequence.map(|value| value.to_string()).unwrap_or_default()
    )
}

fn semantic_location_id(source_id: &str, content_hash: &str) -> String {
    format!("semantic_location:v1:{source_id}:{content_hash}")
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

fn json_string(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn json_bool(value: Option<&JsonValue>) -> Option<bool> {
    value.and_then(|value| value.as_bool())
}

fn compact_json_object(entries: Vec<(&str, Option<JsonValue>)>) -> Option<JsonValue> {
    let mut object = serde_json::Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            if !value.is_null() {
                object.insert(key.to_string(), value);
            }
        }
    }
    (!object.is_empty()).then_some(JsonValue::Object(object))
}

fn json_number_value(value: Option<f64>) -> Option<JsonValue> {
    value
        .and_then(serde_json::Number::from_f64)
        .map(JsonValue::Number)
}

fn json_i64_value(value: Option<i64>) -> Option<JsonValue> {
    value.map(|value| JsonValue::Number(value.into()))
}

fn json_string_value(value: Option<String>) -> Option<JsonValue> {
    value.map(JsonValue::String)
}

fn json_bool_value(value: Option<bool>) -> Option<JsonValue> {
    value.map(JsonValue::Bool)
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
    value.get("semanticSegments").is_some()
        || value.get("rawSignals").is_some()
        || value.get("userLocationProfile").is_some()
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
                    return Ok(GeoFileFormat::GoogleTimelineJson);
                }
                if parsed
                    .get("timelineObjects")
                    .and_then(|value| value.as_array())
                    .is_some()
                {
                    geo_import_debug_json(
                        path,
                        "Google Semantic Location History is not supported yet",
                        &parsed,
                    );
                    return Err("This looks like Google Semantic Location History JSON. That is valid Google Takeout data, but this importer currently supports only raw Records.json and the newer Timeline JSON export.".to_string());
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
                    kind: "geo_point".to_string(),
                    latitude,
                    longitude,
                    timestamp,
                    end_timestamp: None,
                    source_dataset: None,
                    source_type: None,
                    accuracy_meters: None,
                    altitude_meters: None,
                    vertical_accuracy_meters: None,
                    velocity_meters_per_second: None,
                    heading_degrees: None,
                    group_id: None,
                    sequence: None,
                    metadata: None,
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
        GeoFileFormat::GoogleTimelineJson => {
            let (items, skipped_points) = parse_google_timeline_location_items(text)?;
            let points = items
                .iter()
                .filter_map(|item| {
                    if item.kind != "geo_point" {
                        return None;
                    }
                    Some(ParsedGeoPoint {
                        index: item.index,
                        kind: "geo_point".to_string(),
                        latitude: item.latitude?,
                        longitude: item.longitude?,
                        timestamp: item.timestamp?,
                        end_timestamp: item.end_timestamp,
                        source_dataset: item.source_dataset.clone(),
                        source_type: item.source_type.clone(),
                        accuracy_meters: item.accuracy_meters,
                        altitude_meters: item.altitude_meters,
                        vertical_accuracy_meters: item.vertical_accuracy_meters,
                        velocity_meters_per_second: item.velocity_meters_per_second,
                        heading_degrees: item.heading_degrees,
                        group_id: item.group_id.clone(),
                        sequence: item.sequence,
                        metadata: item.metadata.clone(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(ParsedGeoFile {
                points,
                skipped_points,
                mime_type: "application/json".to_string(),
            })
        }
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
        if trimmed.contains("\"semanticSegments\"")
            || trimmed.contains("\"rawSignals\"")
            || trimmed.contains("\"userLocationProfile\"")
        {
            return Ok(GeoFileFormat::GoogleTimelineJson);
        }
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
                                        kind: "geo_point".to_string(),
                                        latitude,
                                        longitude,
                                        timestamp,
                                        end_timestamp: None,
                                        source_dataset: None,
                                        source_type: None,
                                        accuracy_meters: None,
                                        altitude_meters: None,
                                        vertical_accuracy_meters: None,
                                        velocity_meters_per_second: None,
                                        heading_degrees: None,
                                        group_id: None,
                                        sequence: None,
                                        metadata: None,
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
                kind: "geo_point".to_string(),
                latitude,
                longitude,
                timestamp,
                end_timestamp: None,
                source_dataset: Some("google_records".to_string()),
                source_type: json_string(entry.get("source")),
                accuracy_meters: json_number(entry.get("accuracy")),
                altitude_meters: json_number(entry.get("altitude")),
                vertical_accuracy_meters: json_number(entry.get("verticalAccuracy")),
                velocity_meters_per_second: json_number(entry.get("velocity")),
                heading_degrees: json_number(entry.get("heading")),
                group_id: None,
                sequence: None,
                metadata: compact_json_object(vec![
                    (
                        "deviceTag",
                        json_number_value(json_number(entry.get("deviceTag"))),
                    ),
                    (
                        "platformType",
                        json_string_value(json_string(entry.get("platformType"))),
                    ),
                    (
                        "formFactor",
                        json_string_value(json_string(entry.get("formFactor"))),
                    ),
                    (
                        "osLevel",
                        json_number_value(json_number(entry.get("osLevel"))),
                    ),
                    (
                        "serverTimestamp",
                        json_i64_value(entry.get("serverTimestamp").and_then(parse_json_timestamp)),
                    ),
                    (
                        "deviceTimestamp",
                        json_i64_value(entry.get("deviceTimestamp").and_then(parse_json_timestamp)),
                    ),
                    (
                        "batteryCharging",
                        json_bool_value(json_bool(entry.get("batteryCharging"))),
                    ),
                    ("activity", entry.get("activity").cloned()),
                ]),
            })
        }
        _ => None,
    }
}

fn fixed_coordinate(value: Option<f64>) -> Option<String> {
    value.map(|value| format!("{value:.9}"))
}

fn semantic_content_hash(kind: &str, parts: Vec<Option<String>>) -> String {
    let mut values = Vec::with_capacity(parts.len() + 2);
    values.push("timeline:v1".to_string());
    values.push(kind.to_string());
    values.extend(parts.into_iter().map(|value| value.unwrap_or_default()));
    values.join(":")
}

fn stable_json(value: &JsonValue) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn duration_ms(start: Option<i64>, end: Option<i64>) -> Option<i64> {
    match (start, end) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    }
}

fn coordinates_from_lat_lng_string(value: Option<&JsonValue>) -> Option<(f64, f64)> {
    let text = value?.as_str()?;
    let (lat_text, lon_text) = text.split_once(',')?;
    let clean = |part: &str| {
        part.chars()
            .filter(|character| character.is_ascii_digit() || matches!(character, '.' | '-'))
            .collect::<String>()
    };
    let latitude = clean(lat_text).parse::<f64>().ok()?;
    let longitude = clean(lon_text).parse::<f64>().ok()?;
    (valid_latitude(latitude) && valid_longitude(longitude)).then_some((latitude, longitude))
}

fn coordinates_from_object(value: Option<&JsonValue>) -> Option<(f64, f64)> {
    let value = value?;
    coordinates_from_lat_lng_string(value.get("LatLng"))
        .or_else(|| coordinates_from_lat_lng_string(value.get("latLng")))
        .or_else(|| {
            let latitude =
                json_number(value.get("latitudeE7")).map(|value| value / 10_000_000.0)?;
            let longitude =
                json_number(value.get("longitudeE7")).map(|value| value / 10_000_000.0)?;
            (valid_latitude(latitude) && valid_longitude(longitude))
                .then_some((latitude, longitude))
        })
}

fn timeline_segment_group_id(
    segment_index: usize,
    start_time: Option<i64>,
    end_time: Option<i64>,
) -> String {
    format!(
        "google_timeline_segment:v1:{}:{}:{}",
        segment_index + 1,
        start_time
            .map(|value| value.to_string())
            .unwrap_or_default(),
        end_time.map(|value| value.to_string()).unwrap_or_default()
    )
}

fn timeline_path_item(
    segment_index: usize,
    point_index: usize,
    segment: &JsonValue,
    point: &JsonValue,
) -> Option<ParsedGeoItem> {
    let (latitude, longitude) = coordinates_from_lat_lng_string(point.get("point"))
        .or_else(|| coordinates_from_object(Some(point)))?;
    let timestamp = point.get("time").and_then(parse_json_timestamp)?;
    let start_time = segment.get("startTime").and_then(parse_json_timestamp);
    let end_time = segment.get("endTime").and_then(parse_json_timestamp);
    Some(ParsedGeoItem {
        index: point_index as i64 + 1,
        kind: "geo_point".to_string(),
        latitude: Some(latitude),
        longitude: Some(longitude),
        timestamp: Some(timestamp),
        end_timestamp: None,
        source_dataset: Some("google_timeline".to_string()),
        source_type: Some("timeline_path".to_string()),
        accuracy_meters: None,
        altitude_meters: None,
        vertical_accuracy_meters: None,
        velocity_meters_per_second: None,
        heading_degrees: None,
        group_id: Some(timeline_segment_group_id(
            segment_index,
            start_time,
            end_time,
        )),
        sequence: Some(point_index as i64),
        content_hash: None,
        display_name: None,
        metadata: compact_json_object(vec![
            ("segmentStartTime", json_i64_value(start_time)),
            ("segmentEndTime", json_i64_value(end_time)),
        ]),
    })
}

fn raw_signal_position_item(index: usize, signal: &JsonValue) -> Option<ParsedGeoItem> {
    let position = signal.get("position")?;
    let (latitude, longitude) = coordinates_from_object(Some(position))?;
    let timestamp = position
        .get("timestamp")
        .and_then(parse_json_timestamp)
        .or_else(|| {
            position
                .get("timestampMs")
                .and_then(parse_json_timestamp_ms)
        })
        .or_else(|| {
            position
                .get("timestampMS")
                .and_then(parse_json_timestamp_ms)
        })?;
    Some(ParsedGeoItem {
        index: index as i64,
        kind: "geo_point".to_string(),
        latitude: Some(latitude),
        longitude: Some(longitude),
        timestamp: Some(timestamp),
        end_timestamp: None,
        source_dataset: Some("google_timeline_raw_signals".to_string()),
        source_type: json_string(position.get("source")),
        accuracy_meters: json_number(position.get("accuracyMeters"))
            .or_else(|| json_number(position.get("accuracy"))),
        altitude_meters: json_number(position.get("altitudeMeters"))
            .or_else(|| json_number(position.get("altitude"))),
        vertical_accuracy_meters: json_number(position.get("verticalAccuracyMeters"))
            .or_else(|| json_number(position.get("verticalAccuracy"))),
        velocity_meters_per_second: json_number(position.get("speedMetersPerSecond"))
            .or_else(|| json_number(position.get("velocity"))),
        heading_degrees: json_number(position.get("headingDegrees"))
            .or_else(|| json_number(position.get("heading"))),
        group_id: None,
        sequence: None,
        content_hash: None,
        display_name: None,
        metadata: compact_json_object(vec![
            (
                "deviceTag",
                json_number_value(json_number(position.get("deviceTag"))),
            ),
            (
                "platformType",
                json_string_value(json_string(position.get("platformType"))),
            ),
            (
                "formFactor",
                json_string_value(json_string(position.get("formFactor"))),
            ),
            (
                "osLevel",
                json_number_value(json_number(position.get("osLevel"))),
            ),
            (
                "serverTimestamp",
                json_i64_value(
                    position
                        .get("serverTimestamp")
                        .and_then(parse_json_timestamp),
                ),
            ),
            (
                "deviceTimestamp",
                json_i64_value(
                    position
                        .get("deviceTimestamp")
                        .and_then(parse_json_timestamp),
                ),
            ),
            (
                "batteryCharging",
                json_bool_value(json_bool(position.get("batteryCharging"))),
            ),
        ]),
    })
}

fn timeline_visit_item(segment_index: usize, segment: &JsonValue) -> Option<ParsedGeoItem> {
    let visit = segment.get("visit")?;
    let top_candidate = visit.get("topCandidate")?;
    let place_location = top_candidate.get("placeLocation")?;
    let (latitude, longitude) = coordinates_from_object(Some(place_location))?;
    let start_time = segment.get("startTime").and_then(parse_json_timestamp)?;
    let end_time = segment.get("endTime").and_then(parse_json_timestamp);
    let place_id = json_string(top_candidate.get("placeId"));
    let semantic_type = json_string(top_candidate.get("semanticType"));
    let content_hash = semantic_content_hash(
        "timeline_visit",
        vec![
            Some(start_time.to_string()),
            end_time.map(|value| value.to_string()),
            fixed_coordinate(Some(latitude)),
            fixed_coordinate(Some(longitude)),
            place_id.clone(),
            semantic_type.clone(),
        ],
    );
    Some(ParsedGeoItem {
        index: segment_index as i64 + 1,
        kind: "timeline_visit".to_string(),
        latitude: Some(latitude),
        longitude: Some(longitude),
        timestamp: Some(start_time),
        end_timestamp: end_time,
        source_dataset: Some("google_timeline".to_string()),
        source_type: Some("visit".to_string()),
        accuracy_meters: None,
        altitude_meters: None,
        vertical_accuracy_meters: None,
        velocity_meters_per_second: None,
        heading_degrees: None,
        group_id: Some(timeline_segment_group_id(
            segment_index,
            Some(start_time),
            end_time,
        )),
        sequence: None,
        content_hash: Some(content_hash),
        display_name: Some(format!("Visit {}", segment_index + 1)),
        metadata: compact_json_object(vec![
            (
                "durationMs",
                json_i64_value(duration_ms(Some(start_time), end_time)),
            ),
            (
                "hierarchyLevel",
                json_number_value(json_number(visit.get("hierarchyLevel"))),
            ),
            (
                "probability",
                json_number_value(json_number(visit.get("probability"))),
            ),
            ("placeId", json_string_value(place_id)),
            ("semanticType", json_string_value(semantic_type)),
            (
                "topCandidateProbability",
                json_number_value(json_number(top_candidate.get("probability"))),
            ),
        ]),
    })
}

fn timeline_activity_item(segment_index: usize, segment: &JsonValue) -> Option<ParsedGeoItem> {
    let activity = segment.get("activity")?;
    let start = activity.get("start")?;
    let (latitude, longitude) = coordinates_from_object(Some(start))?;
    let end_coordinates = coordinates_from_object(activity.get("end"));
    let start_time = segment.get("startTime").and_then(parse_json_timestamp)?;
    let end_time = segment.get("endTime").and_then(parse_json_timestamp);
    let top_candidate = activity.get("topCandidate");
    let activity_type = top_candidate.and_then(|value| json_string(value.get("type")));
    let content_hash = semantic_content_hash(
        "timeline_activity",
        vec![
            Some(start_time.to_string()),
            end_time.map(|value| value.to_string()),
            fixed_coordinate(Some(latitude)),
            fixed_coordinate(Some(longitude)),
            fixed_coordinate(end_coordinates.map(|value| value.0)),
            fixed_coordinate(end_coordinates.map(|value| value.1)),
            activity_type.clone(),
        ],
    );
    Some(ParsedGeoItem {
        index: segment_index as i64 + 1,
        kind: "timeline_activity".to_string(),
        latitude: Some(latitude),
        longitude: Some(longitude),
        timestamp: Some(start_time),
        end_timestamp: end_time,
        source_dataset: Some("google_timeline".to_string()),
        source_type: Some("activity".to_string()),
        accuracy_meters: None,
        altitude_meters: None,
        vertical_accuracy_meters: None,
        velocity_meters_per_second: None,
        heading_degrees: None,
        group_id: Some(timeline_segment_group_id(
            segment_index,
            Some(start_time),
            end_time,
        )),
        sequence: None,
        content_hash: Some(content_hash),
        display_name: Some(format!("Activity {}", segment_index + 1)),
        metadata: compact_json_object(vec![
            (
                "durationMs",
                json_i64_value(duration_ms(Some(start_time), end_time)),
            ),
            (
                "endLatitude",
                json_number_value(end_coordinates.map(|value| value.0)),
            ),
            (
                "endLongitude",
                json_number_value(end_coordinates.map(|value| value.1)),
            ),
            (
                "distanceMeters",
                json_number_value(json_number(activity.get("distanceMeters"))),
            ),
            ("activityType", json_string_value(activity_type)),
            (
                "probability",
                json_number_value(
                    top_candidate
                        .and_then(|value| json_number(value.get("probability")))
                        .or_else(|| json_number(activity.get("probability"))),
                ),
            ),
            ("parking", activity.get("parking").cloned()),
        ]),
    })
}

fn activity_sample_item(index: usize, signal: &JsonValue) -> Option<ParsedGeoItem> {
    let record = signal.get("activityRecord")?;
    let timestamp = record.get("timestamp").and_then(parse_json_timestamp)?;
    let probable_activities = record
        .get("probableActivities")
        .cloned()
        .unwrap_or_else(|| JsonValue::Array(Vec::new()));
    Some(ParsedGeoItem {
        index: index as i64,
        kind: "activity_sample".to_string(),
        latitude: None,
        longitude: None,
        timestamp: Some(timestamp),
        end_timestamp: None,
        source_dataset: Some("google_timeline_raw_signals".to_string()),
        source_type: Some("activity_record".to_string()),
        accuracy_meters: None,
        altitude_meters: None,
        vertical_accuracy_meters: None,
        velocity_meters_per_second: None,
        heading_degrees: None,
        group_id: None,
        sequence: None,
        content_hash: Some(semantic_content_hash(
            "activity_sample",
            vec![
                Some(timestamp.to_string()),
                Some(stable_json(&probable_activities)),
            ],
        )),
        display_name: Some(format!("Activity sample {index}")),
        metadata: compact_json_object(vec![("probableActivities", Some(probable_activities))]),
    })
}

fn frequent_place_item(index: usize, place: &JsonValue) -> Option<ParsedGeoItem> {
    let place_location = place.get("placeLocation")?;
    let (latitude, longitude) = coordinates_from_object(Some(place_location))?;
    let place_id = json_string(place.get("placeId"));
    let label = json_string(place.get("label"));
    Some(ParsedGeoItem {
        index: index as i64,
        kind: "frequent_place".to_string(),
        latitude: Some(latitude),
        longitude: Some(longitude),
        timestamp: None,
        end_timestamp: None,
        source_dataset: Some("google_timeline".to_string()),
        source_type: Some("frequent_place".to_string()),
        accuracy_meters: None,
        altitude_meters: None,
        vertical_accuracy_meters: None,
        velocity_meters_per_second: None,
        heading_degrees: None,
        group_id: None,
        sequence: None,
        content_hash: Some(semantic_content_hash(
            "frequent_place",
            vec![
                place_id.clone(),
                label.clone(),
                fixed_coordinate(Some(latitude)),
                fixed_coordinate(Some(longitude)),
            ],
        )),
        display_name: Some(
            label
                .as_ref()
                .map(|label| format!("Frequent place: {label}"))
                .unwrap_or_else(|| format!("Frequent place {index}")),
        ),
        metadata: compact_json_object(vec![
            ("placeId", json_string_value(place_id)),
            ("label", json_string_value(label)),
        ]),
    })
}

fn parse_google_timeline_location_items(json: &str) -> AppResult<(Vec<ParsedGeoItem>, i64)> {
    let parsed: JsonValue = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let looks_like_timeline = parsed.get("semanticSegments").is_some()
        || parsed.get("rawSignals").is_some()
        || parsed.get("userLocationProfile").is_some();
    if !looks_like_timeline {
        return Err(
            "The selected JSON file does not look like a Google Timeline export.".to_string(),
        );
    }

    let mut items = Vec::<ParsedGeoItem>::new();
    let mut skipped_points = 0_i64;

    if let Some(raw_signals) = parsed.get("rawSignals").and_then(|value| value.as_array()) {
        for (signal_index, signal) in raw_signals.iter().enumerate() {
            if signal.get("wifiScan").is_some() {
                continue;
            }
            if let Some(item) = raw_signal_position_item(signal_index + 1, signal) {
                items.push(item);
            } else if let Some(item) = activity_sample_item(signal_index + 1, signal) {
                items.push(item);
            } else {
                skipped_points += 1;
            }
        }
    }

    if let Some(segments) = parsed
        .get("semanticSegments")
        .and_then(|value| value.as_array())
    {
        for (segment_index, segment) in segments.iter().enumerate() {
            if let Some(path) = segment
                .get("timelinePath")
                .and_then(|value| value.as_array())
            {
                for (point_index, point) in path.iter().enumerate() {
                    if let Some(item) =
                        timeline_path_item(segment_index, point_index, segment, point)
                    {
                        items.push(item);
                    } else {
                        skipped_points += 1;
                    }
                }
            }
            if let Some(item) = timeline_visit_item(segment_index, segment) {
                items.push(item);
            }
            if let Some(item) = timeline_activity_item(segment_index, segment) {
                items.push(item);
            }
        }
    }

    if let Some(frequent_places) = parsed
        .get("userLocationProfile")
        .and_then(|value| value.get("frequentPlaces"))
        .and_then(|value| value.as_array())
    {
        for (place_index, place) in frequent_places.iter().enumerate() {
            if let Some(item) = frequent_place_item(place_index + 1, place) {
                items.push(item);
            } else {
                skipped_points += 1;
            }
        }
    }

    Ok((items, skipped_points))
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
        source_dataset: None,
        source_type: None,
        group_id: None,
        sequence: None,
        timestamp: None,
        end_timestamp: None,
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
        end_timestamp: None,
        latitude: None,
        longitude: None,
        thumbnail_key: None,
        source_dataset: None,
        source_type: None,
        accuracy_meters: None,
        altitude_meters: None,
        vertical_accuracy_meters: None,
        velocity_meters_per_second: None,
        heading_degrees: None,
        group_id: None,
        sequence: None,
        metadata: None,
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

fn parsed_item_content_hash(item: &ParsedGeoItem) -> String {
    if let Some(content_hash) = item.content_hash.as_ref() {
        return content_hash.clone();
    }
    if item.kind == "geo_point" {
        if let (Some(latitude), Some(longitude), Some(timestamp)) =
            (item.latitude, item.longitude, item.timestamp)
        {
            return geo_point_content_hash(latitude, longitude, timestamp);
        }
    }
    semantic_content_hash(
        &item.kind,
        vec![
            item.timestamp.map(|value| value.to_string()),
            item.end_timestamp.map(|value| value.to_string()),
            item.latitude.map(|value| value.to_string()),
            item.longitude.map(|value| value.to_string()),
            item.source_dataset.clone(),
            item.source_type.clone(),
            item.group_id.clone(),
            item.sequence.map(|value| value.to_string()),
            item.metadata.as_ref().map(stable_json),
        ],
    )
}

fn media_item_from_parsed_geo_item(
    source: &MediaSource,
    mime_type: &str,
    item: &ParsedGeoItem,
) -> MediaItem {
    let content_hash = parsed_item_content_hash(item);
    let is_point = item.kind == "geo_point";
    let location = MediaLocation {
        id: if is_point {
            geo_point_location_id(
                &source.id,
                &content_hash,
                item.source_dataset.as_deref(),
                item.source_type.as_deref(),
                item.group_id.as_deref(),
                item.sequence,
            )
        } else {
            semantic_location_id(&source.id, &content_hash)
        },
        source_id: source.id.clone(),
        source_label: source.label.clone(),
        root_path: source.root_path.clone(),
        relative_path: None,
        absolute_path: None,
        point_index: Some(item.index),
        source_dataset: item.source_dataset.clone(),
        source_type: item.source_type.clone(),
        group_id: item.group_id.clone(),
        sequence: item.sequence,
        timestamp: item.timestamp,
        end_timestamp: item.end_timestamp,
    };
    MediaItem {
        id: content_hash.clone(),
        content_hash,
        source_id: source.id.clone(),
        relative_path: source.label.clone(),
        display_name: item
            .display_name
            .clone()
            .unwrap_or_else(|| format!("{} #{}", source.label, item.index)),
        kind: item.kind.clone(),
        mime_type: mime_type.to_string(),
        size_bytes: 0,
        duration_ms: item
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("durationMs"))
            .and_then(|value| value.as_i64()),
        timestamp: item.timestamp,
        end_timestamp: item.end_timestamp,
        latitude: item.latitude,
        longitude: item.longitude,
        thumbnail_key: None,
        source_dataset: item.source_dataset.clone(),
        source_type: item.source_type.clone(),
        accuracy_meters: item.accuracy_meters,
        altitude_meters: item.altitude_meters,
        vertical_accuracy_meters: item.vertical_accuracy_meters,
        velocity_meters_per_second: item.velocity_meters_per_second,
        heading_degrees: item.heading_degrees,
        group_id: item.group_id.clone(),
        sequence: item.sequence,
        metadata: item.metadata.clone(),
        locations: vec![location],
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
        id: geo_point_location_id(
            &source.id,
            &content_hash,
            point.source_dataset.as_deref(),
            point.source_type.as_deref(),
            point.group_id.as_deref(),
            point.sequence,
        ),
        source_id: source.id.clone(),
        source_label: source.label.clone(),
        root_path: source.root_path.clone(),
        relative_path: None,
        absolute_path: None,
        point_index: Some(point.index as i64),
        source_dataset: point.source_dataset.clone(),
        source_type: point.source_type.clone(),
        group_id: point.group_id.clone(),
        sequence: point.sequence,
        timestamp: Some(point.timestamp),
        end_timestamp: point.end_timestamp,
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
        end_timestamp: point.end_timestamp,
        latitude: Some(point.latitude),
        longitude: Some(point.longitude),
        thumbnail_key: None,
        source_dataset: point.source_dataset.clone(),
        source_type: point.source_type.clone(),
        accuracy_meters: point.accuracy_meters,
        altitude_meters: point.altitude_meters,
        vertical_accuracy_meters: point.vertical_accuracy_meters,
        velocity_meters_per_second: point.velocity_meters_per_second,
        heading_degrees: point.heading_degrees,
        group_id: point.group_id.clone(),
        sequence: point.sequence,
        metadata: point.metadata.clone(),
        locations: vec![location],
    }
}

fn derived_absolute_path(kind: &str, location: &MediaLocation) -> Option<String> {
    let root_path = location.root_path.as_ref()?;
    if !matches!(kind, "image" | "video") {
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
    if !matches!(kind, "image" | "video") {
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

fn normalize_media_item(
    mut item: MediaItem,
    mut locations: Vec<MediaLocation>,
    preferred_source_id: Option<&str>,
) -> MediaItem {
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
}

fn merge_metadata(existing: &Option<JsonValue>, incoming: &Option<JsonValue>) -> Option<JsonValue> {
    match (incoming, existing) {
        (Some(JsonValue::Object(incoming)), Some(JsonValue::Object(existing))) => {
            let mut object = incoming.clone();
            for (key, value) in existing.iter() {
                object.insert(key.clone(), value.clone());
            }
            Some(JsonValue::Object(object))
        }
        (Some(_), Some(existing)) => Some(existing.clone()),
        (None, Some(existing)) => Some(existing.clone()),
        (Some(incoming), None) => Some(incoming.clone()),
        (None, None) => None,
    }
}

fn merge_media_items(existing: &MediaItem, incoming: &MediaItem) -> MediaItem {
    let mut locations = existing.locations.clone();
    locations.extend(incoming.locations.clone());
    MediaItem {
        id: existing.id.clone(),
        content_hash: existing.content_hash.clone(),
        source_id: existing.source_id.clone(),
        relative_path: existing.relative_path.clone(),
        display_name: existing.display_name.clone(),
        kind: existing.kind.clone(),
        mime_type: existing.mime_type.clone(),
        size_bytes: existing.size_bytes.max(incoming.size_bytes),
        duration_ms: existing.duration_ms.or(incoming.duration_ms),
        timestamp: existing.timestamp.or(incoming.timestamp),
        end_timestamp: existing.end_timestamp.or(incoming.end_timestamp),
        latitude: existing.latitude.or(incoming.latitude),
        longitude: existing.longitude.or(incoming.longitude),
        thumbnail_key: existing
            .thumbnail_key
            .clone()
            .or_else(|| incoming.thumbnail_key.clone()),
        source_dataset: existing
            .source_dataset
            .clone()
            .or_else(|| incoming.source_dataset.clone()),
        source_type: existing
            .source_type
            .clone()
            .or_else(|| incoming.source_type.clone()),
        accuracy_meters: existing.accuracy_meters.or(incoming.accuracy_meters),
        altitude_meters: existing.altitude_meters.or(incoming.altitude_meters),
        vertical_accuracy_meters: existing
            .vertical_accuracy_meters
            .or(incoming.vertical_accuracy_meters),
        velocity_meters_per_second: existing
            .velocity_meters_per_second
            .or(incoming.velocity_meters_per_second),
        heading_degrees: existing.heading_degrees.or(incoming.heading_degrees),
        group_id: existing
            .group_id
            .clone()
            .or_else(|| incoming.group_id.clone()),
        sequence: existing.sequence.or(incoming.sequence),
        metadata: merge_metadata(&existing.metadata, &incoming.metadata),
        locations,
    }
}

#[derive(Clone)]
struct NativeAssetTableHeader {
    catalog_version: i64,
    count: usize,
    entry_size: usize,
}

#[derive(Clone)]
struct NativeAssetTable {
    assets_dir: PathBuf,
    record_index_path: PathBuf,
    header: NativeAssetTableHeader,
}

#[derive(Clone)]
struct NativeAssetIdMap {
    path: PathBuf,
    header: NativeAssetTableHeader,
}

struct NativeAssetStore {
    table: NativeAssetTable,
    id_map: Option<NativeAssetIdMap>,
}

#[derive(Clone, Copy)]
struct NativeAssetRecordEntry {
    asset_id: usize,
    chunk_id: usize,
    record_offset: usize,
    record_length: usize,
}

struct NativeAssetReadResult {
    item: MediaItem,
}

#[derive(Clone, Copy, Default)]
struct NativeAssetReadMetrics {
    disk_read_bytes: usize,
    disk_read_count: usize,
}

fn native_asset_chunk_file_name(chunk_id: usize) -> String {
    format!("{ASSET_CHUNK_PREFIX}{chunk_id:06}{ASSET_BINARY_CHUNK_EXTENSION}")
}

fn cleanup_native_asset_store_files(asset_dir: &Path) -> AppResult<()> {
    fs::create_dir_all(asset_dir).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(asset_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_asset_store_file = file_name == ASSET_RECORD_INDEX_FILE
            || file_name == ASSET_ID_MAP_FILE
            || file_name == FILE_CATALOG_ASSETS
            || (file_name.starts_with(ASSET_CHUNK_PREFIX)
                && file_name.ends_with(ASSET_BINARY_CHUNK_EXTENSION));
        if is_asset_store_file {
            let path = entry.path();
            if path.is_file() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn encode_binary_header(
    magic: u32,
    catalog_version: i64,
    count: usize,
    entry_size: usize,
) -> [u8; ASSET_TABLE_HEADER_SIZE] {
    let mut bytes = [0_u8; ASSET_TABLE_HEADER_SIZE];
    write_u32_le(&mut bytes, 0, magic);
    write_u32_le(&mut bytes, 4, BINARY_SCHEMA_VERSION);
    write_f64_le(&mut bytes, 8, catalog_version as f64);
    write_f64_le(&mut bytes, 16, count as f64);
    write_u32_le(&mut bytes, 24, entry_size as u32);
    bytes
}

fn read_native_binary_header(path: &Path, expected_magic: u32) -> Option<NativeAssetTableHeader> {
    let mut file = File::open(path).ok()?;
    let mut bytes = [0_u8; ASSET_TABLE_HEADER_SIZE];
    file.read_exact(&mut bytes).ok()?;
    if read_u32_le(&bytes, 0)? != expected_magic {
        return None;
    }
    if read_u32_le(&bytes, 4)? != BINARY_SCHEMA_VERSION {
        return None;
    }
    let catalog_version = read_f64_le(&bytes, 8)?;
    let count = read_f64_le(&bytes, 16)?;
    let entry_size = read_u32_le(&bytes, 24)? as usize;
    if !catalog_version.is_finite()
        || !count.is_finite()
        || catalog_version.fract() != 0.0
        || count.fract() != 0.0
        || catalog_version < 0.0
        || count < 0.0
        || count > usize::MAX as f64
    {
        return None;
    }
    Some(NativeAssetTableHeader {
        catalog_version: catalog_version as i64,
        count: count as usize,
        entry_size,
    })
}

fn encode_asset_id_key(id: &str) -> [u8; 64] {
    let mut bytes = [0_u8; 64];
    let lower = id.to_ascii_lowercase();
    let encoded = lower.as_bytes();
    let length = encoded.len().min(bytes.len());
    bytes[..length].copy_from_slice(&encoded[..length]);
    bytes
}

fn compare_asset_id_key(left: &[u8], right: &[u8; 64]) -> std::cmp::Ordering {
    for (left_byte, right_byte) in left.iter().take(64).zip(right.iter()) {
        match left_byte.cmp(right_byte) {
            std::cmp::Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
}

fn write_native_asset_store(
    asset_dir: &Path,
    catalog_version: i64,
    items: &[MediaItem],
) -> AppResult<()> {
    cleanup_native_asset_store_files(asset_dir)?;

    let mut record_index =
        File::create(asset_dir.join(ASSET_RECORD_INDEX_FILE)).map_err(|error| error.to_string())?;
    record_index
        .write_all(&encode_binary_header(
            ASSET_TABLE_MAGIC,
            catalog_version,
            items.len(),
            ASSET_RECORD_INDEX_ENTRY_SIZE,
        ))
        .map_err(|error| error.to_string())?;

    for offset in (0..items.len()).step_by(ASSET_CHUNK_SIZE) {
        let chunk_id = offset / ASSET_CHUNK_SIZE;
        let chunk = &items[offset..items.len().min(offset + ASSET_CHUNK_SIZE)];
        let mut chunk_bytes = Vec::<u8>::new();
        let mut record_bytes = vec![0_u8; chunk.len() * ASSET_RECORD_INDEX_ENTRY_SIZE];
        for (index, item) in chunk.iter().enumerate() {
            let payload = serde_json::to_vec(item).map_err(|error| error.to_string())?;
            if payload.len() > u32::MAX as usize || chunk_bytes.len() > u32::MAX as usize {
                return Err(
                    "Native asset record is too large for the binary asset table.".to_string(),
                );
            }
            let record_offset = chunk_bytes.len();
            chunk_bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            chunk_bytes.extend_from_slice(&payload);
            let entry_offset = index * ASSET_RECORD_INDEX_ENTRY_SIZE;
            write_u32_le(&mut record_bytes, entry_offset, chunk_id as u32);
            write_u32_le(&mut record_bytes, entry_offset + 4, record_offset as u32);
            write_u32_le(&mut record_bytes, entry_offset + 8, payload.len() as u32);
        }
        fs::write(
            asset_dir.join(native_asset_chunk_file_name(chunk_id)),
            chunk_bytes,
        )
        .map_err(|error| error.to_string())?;
        record_index
            .write_all(&record_bytes)
            .map_err(|error| error.to_string())?;
    }

    let mut id_map_ids = (0..items.len()).collect::<Vec<_>>();
    id_map_ids.sort_by(|left, right| {
        items[*left]
            .id
            .cmp(&items[*right].id)
            .then_with(|| left.cmp(right))
    });
    let mut id_map =
        File::create(asset_dir.join(ASSET_ID_MAP_FILE)).map_err(|error| error.to_string())?;
    id_map
        .write_all(&encode_binary_header(
            ASSET_ID_MAP_MAGIC,
            catalog_version,
            items.len(),
            ASSET_ID_MAP_ENTRY_SIZE,
        ))
        .map_err(|error| error.to_string())?;
    for offset in (0..id_map_ids.len()).step_by(ASSET_CHUNK_SIZE) {
        let count = id_map_ids.len().min(offset + ASSET_CHUNK_SIZE) - offset;
        let mut bytes = vec![0_u8; count * ASSET_ID_MAP_ENTRY_SIZE];
        for index in 0..count {
            let asset_id = id_map_ids[offset + index];
            let entry_offset = index * ASSET_ID_MAP_ENTRY_SIZE;
            bytes[entry_offset..entry_offset + 64]
                .copy_from_slice(&encode_asset_id_key(&items[asset_id].id));
            write_u64_le(&mut bytes, entry_offset + 64, asset_id as u64);
        }
        id_map
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn open_current_native_asset_table(
    app: &AppHandle,
    manifest: &FileCatalogManifest,
) -> AppResult<Option<NativeAssetTable>> {
    let assets_dir = assets_dir(app)?;
    let record_index_path = assets_dir.join(ASSET_RECORD_INDEX_FILE);
    let Some(header) = read_native_binary_header(&record_index_path, ASSET_TABLE_MAGIC) else {
        return Ok(None);
    };
    if header.catalog_version != manifest.catalog_version
        || header.count != manifest.asset_count
        || header.entry_size != ASSET_RECORD_INDEX_ENTRY_SIZE
    {
        return Ok(None);
    }
    Ok(Some(NativeAssetTable {
        assets_dir,
        record_index_path,
        header,
    }))
}

fn open_current_native_asset_id_map(
    app: &AppHandle,
    manifest: &FileCatalogManifest,
) -> AppResult<Option<NativeAssetIdMap>> {
    let path = assets_dir(app)?.join(ASSET_ID_MAP_FILE);
    let Some(header) = read_native_binary_header(&path, ASSET_ID_MAP_MAGIC) else {
        return Ok(None);
    };
    if header.catalog_version != manifest.catalog_version
        || header.count != manifest.asset_count
        || header.entry_size != ASSET_ID_MAP_ENTRY_SIZE
    {
        return Ok(None);
    }
    Ok(Some(NativeAssetIdMap { path, header }))
}

fn open_current_native_asset_store(
    app: &AppHandle,
    manifest: &FileCatalogManifest,
) -> AppResult<Option<NativeAssetStore>> {
    let Some(table) = open_current_native_asset_table(app, manifest)? else {
        return Ok(None);
    };
    let id_map = open_current_native_asset_id_map(app, manifest)?;
    Ok(Some(NativeAssetStore { table, id_map }))
}

fn rewrite_legacy_asset_store(
    app: &AppHandle,
    manifest: &mut FileCatalogManifest,
) -> AppResult<bool> {
    let path = assets_dir(app)?.join(FILE_CATALOG_ASSETS);
    if !path.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let items = serde_json::from_str::<Vec<MediaItem>>(&text).map_err(|error| error.to_string())?;
    manifest.asset_count = items.len();
    manifest.location_count = items.iter().map(|item| item.locations.len()).sum();
    manifest.materialized_version = manifest.catalog_version;
    manifest.asset_store_version = manifest.catalog_version;
    manifest.next_asset_id = manifest.next_asset_id.max(items.len() as i64);
    write_native_asset_store(&assets_dir(app)?, manifest.catalog_version, &items)?;
    save_file_catalog_manifest(app, manifest)?;
    Ok(true)
}

fn ensure_current_native_asset_store(app: &AppHandle) -> AppResult<NativeAssetStore> {
    let mut manifest = load_file_catalog_manifest(app)?;
    if manifest.materialized_version != manifest.catalog_version {
        materialize_file_catalog(app, &mut manifest)?;
    }
    if let Some(store) = open_current_native_asset_store(app, &manifest)? {
        return Ok(store);
    }
    if rewrite_legacy_asset_store(app, &mut manifest)? {
        if let Some(store) = open_current_native_asset_store(app, &manifest)? {
            return Ok(store);
        }
    }
    materialize_file_catalog(app, &mut manifest)?;
    open_current_native_asset_store(app, &manifest)?
        .ok_or_else(|| "Native asset table is missing after materialization.".to_string())
}

fn read_all_native_assets_from_table(table: &NativeAssetTable) -> AppResult<Vec<MediaItem>> {
    let mut items = Vec::<MediaItem>::with_capacity(table.header.count);
    for chunk_id in 0.. {
        if items.len() >= table.header.count {
            break;
        }
        let bytes = fs::read(
            table
                .assets_dir
                .join(native_asset_chunk_file_name(chunk_id)),
        )
        .map_err(|error| error.to_string())?;
        let mut offset = 0_usize;
        while offset + 4 <= bytes.len() && items.len() < table.header.count {
            let length = read_u32_le(&bytes, offset)
                .ok_or_else(|| "Native asset chunk has an invalid record header.".to_string())?
                as usize;
            offset += 4;
            let end = offset.saturating_add(length);
            if length == 0 || end > bytes.len() {
                return Err("Native asset chunk is truncated or corrupt.".to_string());
            }
            items.push(
                serde_json::from_slice(&bytes[offset..end]).map_err(|error| error.to_string())?,
            );
            offset = end;
        }
    }
    if items.len() != table.header.count {
        return Err("Native asset table ended before all assets were read.".to_string());
    }
    Ok(items)
}

fn read_native_asset_record_entries(
    table: &NativeAssetTable,
    asset_ids: &[usize],
) -> AppResult<(
    HashMap<usize, NativeAssetRecordEntry>,
    NativeAssetReadMetrics,
)> {
    let mut metrics = NativeAssetReadMetrics::default();
    let mut valid_ids = asset_ids
        .iter()
        .copied()
        .filter(|asset_id| *asset_id < table.header.count)
        .collect::<Vec<_>>();
    valid_ids.sort_unstable();
    valid_ids.dedup();
    if valid_ids.is_empty() {
        return Ok((HashMap::new(), metrics));
    }

    let mut file = File::open(&table.record_index_path).map_err(|error| error.to_string())?;
    let mut entries = HashMap::<usize, NativeAssetRecordEntry>::new();
    let mut range_start_index = 0_usize;
    while range_start_index < valid_ids.len() {
        let first_asset_id = valid_ids[range_start_index];
        let mut range_end_index = range_start_index + 1;
        while range_end_index < valid_ids.len()
            && valid_ids[range_end_index] == valid_ids[range_end_index - 1] + 1
        {
            range_end_index += 1;
        }
        let count = range_end_index - range_start_index;
        let byte_offset = ASSET_TABLE_HEADER_SIZE as u64
            + first_asset_id as u64 * ASSET_RECORD_INDEX_ENTRY_SIZE as u64;
        let byte_len = count * ASSET_RECORD_INDEX_ENTRY_SIZE;
        let mut bytes = vec![0_u8; byte_len];
        file.seek(SeekFrom::Start(byte_offset))
            .map_err(|error| error.to_string())?;
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        metrics.disk_read_bytes += byte_len;
        metrics.disk_read_count += 1;

        for offset in 0..count {
            let record_offset = offset * ASSET_RECORD_INDEX_ENTRY_SIZE;
            let asset_id = first_asset_id + offset;
            let record_length = read_u32_le(&bytes, record_offset + 8)
                .ok_or_else(|| "Native asset record index is corrupt.".to_string())?
                as usize;
            if record_length == 0 {
                continue;
            }
            entries.insert(
                asset_id,
                NativeAssetRecordEntry {
                    asset_id,
                    chunk_id: read_u32_le(&bytes, record_offset)
                        .ok_or_else(|| "Native asset record index is corrupt.".to_string())?
                        as usize,
                    record_offset: read_u32_le(&bytes, record_offset + 4)
                        .ok_or_else(|| "Native asset record index is corrupt.".to_string())?
                        as usize,
                    record_length,
                },
            );
        }
        range_start_index = range_end_index;
    }
    Ok((entries, metrics))
}

fn read_native_assets_by_asset_ids_from_table(
    table: &NativeAssetTable,
    asset_ids: &[usize],
) -> AppResult<(Vec<NativeAssetReadResult>, NativeAssetReadMetrics)> {
    let (entries, mut metrics) = read_native_asset_record_entries(table, asset_ids)?;
    if entries.is_empty() {
        return Ok((Vec::new(), metrics));
    }

    let mut entries_by_chunk = HashMap::<usize, Vec<NativeAssetRecordEntry>>::new();
    for entry in entries.into_values() {
        entries_by_chunk
            .entry(entry.chunk_id)
            .or_default()
            .push(entry);
    }

    let mut item_by_asset_id = HashMap::<usize, MediaItem>::new();
    for (chunk_id, chunk_entries) in entries_by_chunk {
        let path = table
            .assets_dir
            .join(native_asset_chunk_file_name(chunk_id));
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        metrics.disk_read_bytes += bytes.len();
        metrics.disk_read_count += 1;
        for entry in chunk_entries {
            let payload_offset = entry.record_offset.saturating_add(4);
            let payload_end = payload_offset.saturating_add(entry.record_length);
            if payload_end > bytes.len() {
                continue;
            }
            let item = serde_json::from_slice::<MediaItem>(&bytes[payload_offset..payload_end])
                .map_err(|error| error.to_string())?;
            item_by_asset_id.insert(entry.asset_id, item);
        }
    }

    let items = asset_ids
        .iter()
        .filter_map(|asset_id| {
            item_by_asset_id
                .get(asset_id)
                .cloned()
                .map(|item| NativeAssetReadResult { item })
        })
        .collect::<Vec<_>>();
    Ok((items, metrics))
}

fn find_native_asset_ids_by_media_ids(
    id_map: &NativeAssetIdMap,
    ids: &[String],
) -> AppResult<(Vec<usize>, NativeAssetReadMetrics)> {
    let mut metrics = NativeAssetReadMetrics::default();
    if ids.is_empty() || id_map.header.count == 0 {
        return Ok((Vec::new(), metrics));
    }
    let mut file = File::open(&id_map.path).map_err(|error| error.to_string())?;
    let mut asset_ids = Vec::<usize>::new();
    for id in ids {
        let target = encode_asset_id_key(id);
        let mut low = 0_usize;
        let mut high = id_map.header.count;
        while low < high {
            let middle = (low + high) / 2;
            let offset =
                ASSET_ID_MAP_HEADER_SIZE as u64 + middle as u64 * ASSET_ID_MAP_ENTRY_SIZE as u64;
            let mut bytes = [0_u8; ASSET_ID_MAP_ENTRY_SIZE];
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| error.to_string())?;
            file.read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
            metrics.disk_read_bytes += ASSET_ID_MAP_ENTRY_SIZE;
            metrics.disk_read_count += 1;
            match compare_asset_id_key(&bytes[..64], &target) {
                std::cmp::Ordering::Less => low = middle + 1,
                _ => high = middle,
            }
        }
        if low >= id_map.header.count {
            continue;
        }
        let offset = ASSET_ID_MAP_HEADER_SIZE as u64 + low as u64 * ASSET_ID_MAP_ENTRY_SIZE as u64;
        let mut bytes = [0_u8; ASSET_ID_MAP_ENTRY_SIZE];
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        metrics.disk_read_bytes += ASSET_ID_MAP_ENTRY_SIZE;
        metrics.disk_read_count += 1;
        if compare_asset_id_key(&bytes[..64], &target) != std::cmp::Ordering::Equal {
            continue;
        }
        let Some(asset_id) = read_u64_le(&bytes, 64) else {
            continue;
        };
        let asset_id = asset_id as usize;
        if asset_id < id_map.header.count {
            asset_ids.push(asset_id);
        }
    }
    Ok((asset_ids, metrics))
}

fn read_current_native_assets_by_asset_ids(
    app: &AppHandle,
    asset_ids: &[usize],
) -> AppResult<(Vec<NativeAssetReadResult>, NativeAssetReadMetrics)> {
    let store = ensure_current_native_asset_store(app)?;
    read_native_assets_by_asset_ids_from_table(&store.table, asset_ids)
}

fn read_current_native_assets_by_media_ids(
    app: &AppHandle,
    ids: &[String],
) -> AppResult<(Vec<MediaItem>, NativeAssetReadMetrics)> {
    let store = ensure_current_native_asset_store(app)?;
    if let Some(id_map) = store.id_map.as_ref() {
        let (asset_ids, mut metrics) = find_native_asset_ids_by_media_ids(id_map, ids)?;
        let (rows, read_metrics) =
            read_native_assets_by_asset_ids_from_table(&store.table, &asset_ids)?;
        metrics.disk_read_bytes += read_metrics.disk_read_bytes;
        metrics.disk_read_count += read_metrics.disk_read_count;
        return Ok((rows.into_iter().map(|row| row.item).collect(), metrics));
    }

    let by_id = read_all_native_assets_from_table(&store.table)?
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();
    Ok((
        ids.iter().filter_map(|id| by_id.get(id).cloned()).collect(),
        NativeAssetReadMetrics::default(),
    ))
}

fn active_media_items(app: &AppHandle) -> AppResult<Vec<MediaItem>> {
    let store = ensure_current_native_asset_store(app)?;
    read_all_native_assets_from_table(&store.table)
}

fn materialize_file_catalog(
    app: &AppHandle,
    manifest: &mut FileCatalogManifest,
) -> AppResult<Vec<MediaItem>> {
    materialize_file_catalog_with_progress(app, manifest, None)
}

fn materialize_file_catalog_with_progress(
    app: &AppHandle,
    manifest: &mut FileCatalogManifest,
    mut on_progress: Option<&mut dyn FnMut(usize, usize, &str)>,
) -> AppResult<Vec<MediaItem>> {
    let mut assets = HashMap::<String, MediaItem>::new();
    let mut locations = HashMap::<String, HashMap<String, MediaLocation>>::new();
    let occurrence_dir = occurrences_dir(app)?;
    let active_chunks = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.active)
        .cloned()
        .collect::<Vec<_>>();
    let total_occurrences = active_chunks.iter().map(|chunk| chunk.count).sum::<usize>();
    let mut processed_occurrences = 0_usize;

    for chunk in active_chunks.iter() {
        let Some(source) = manifest.sources.get(&chunk.source_id) else {
            continue;
        };
        if !source.active || source.generation != chunk.generation {
            continue;
        }
        let path = occurrence_dir.join(format!("{}.bin", chunk.id));
        if !path.exists() {
            continue;
        }
        let file = File::open(path).map_err(|error| error.to_string())?;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let occurrence: FileOccurrence =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            processed_occurrences += 1;
            if occurrence.generation != source.generation || occurrence.source_id != source.id {
                continue;
            }
            let content_hash = occurrence.item.content_hash.clone();
            let merged = assets
                .get(&content_hash)
                .map(|existing| merge_media_items(existing, &occurrence.item))
                .unwrap_or_else(|| occurrence.item.clone());
            assets.insert(content_hash.clone(), merged);
            let location_map = locations.entry(content_hash).or_default();
            for location in occurrence.item.locations {
                location_map.insert(location.id.clone(), location);
            }
            if processed_occurrences % 50_000 == 0 {
                if let Some(callback) = on_progress.as_mut() {
                    callback(
                        processed_occurrences,
                        total_occurrences,
                        "reading occurrences",
                    );
                }
            }
        }
    }

    if let Some(callback) = on_progress.as_mut() {
        callback(
            processed_occurrences,
            total_occurrences,
            "normalizing assets",
        );
    }
    let mut items = assets
        .into_values()
        .map(|item| {
            let item_locations = locations
                .remove(&item.content_hash)
                .map(|locations| locations.into_values().collect())
                .unwrap_or_default();
            normalize_media_item(item, item_locations, None)
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| a.content_hash.cmp(&b.content_hash));
    manifest.asset_count = items.len();
    manifest.location_count = items.iter().map(|item| item.locations.len()).sum();
    manifest.materialized_version = manifest.catalog_version;
    manifest.asset_store_version = manifest.catalog_version;
    manifest.next_asset_id = manifest.next_asset_id.max(items.len() as i64);
    fs::create_dir_all(assets_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(catalog_indexes_dir(app)?).map_err(|error| error.to_string())?;
    if let Some(callback) = on_progress.as_mut() {
        callback(items.len(), items.len(), "writing asset table");
    }
    write_native_asset_store(&assets_dir(app)?, manifest.catalog_version, &items)?;
    save_file_catalog_manifest(app, manifest)?;
    Ok(items)
}

fn write_file_catalog_indexes(app: &AppHandle, manifest: &FileCatalogManifest) -> AppResult<()> {
    let indexes_dir = catalog_indexes_dir(app)?;
    let items = active_media_items(app)?;
    let mut time_records = Vec::<NativePackedIndexRecord>::new();
    for (asset_id, item) in items.iter().enumerate() {
        if item.timestamp.is_some() || (item.latitude.is_some() && item.longitude.is_some()) {
            let (
                source_code,
                quality_flags,
                accuracy_meters,
                velocity_meters_per_second,
                heading_degrees,
                group_hash,
                sequence,
            ) = line_payload_from_item(item);
            let record = NativePackedIndexRecord {
                timestamp_sec: item.timestamp.map(timestamp_seconds).unwrap_or(0),
                lat_e7: item.latitude.map(lat_e7).unwrap_or(0),
                lon_e7: item.longitude.map(lon_e7).unwrap_or(0),
                asset_id,
                kind_flags: kind_flags(item),
                source_code,
                quality_flags,
                accuracy_meters,
                velocity_meters_per_second,
                heading_degrees,
                group_hash,
                sequence,
            };
            time_records.push(record);
        }
    }
    let _ = fs::remove_file(indexes_dir.join("cell-time.idx"));
    write_packed_index_file(
        &indexes_dir.join(FILE_CATALOG_TIME_GEO_INDEX),
        INDEX_KIND_TIME_GEO,
        manifest,
        &mut time_records,
    )?;
    Ok(())
}

fn prepare_import_source(app: &AppHandle, source: &MediaSource) -> AppResult<i64> {
    let mut manifest = load_file_catalog_manifest(app)?;
    let generation = manifest
        .sources
        .get(&source.id)
        .map(|source| source.generation + 1)
        .unwrap_or(1);
    manifest.sources.insert(
        source.id.clone(),
        FileCatalogSource {
            id: source.id.clone(),
            label: source.label.clone(),
            root_path: source.root_path.clone(),
            generation,
            active: true,
            imported_at: current_timestamp_millis(),
        },
    );
    for chunk in manifest.chunks.iter_mut() {
        if chunk.source_id == source.id {
            chunk.active = false;
        }
    }
    bump_catalog_epoch(app, &mut manifest)?;
    Ok(generation)
}

fn append_media_items(
    app: &AppHandle,
    source_id: &str,
    generation: i64,
    items: &[MediaItem],
) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut manifest = load_file_catalog_manifest(app)?;
    let chunk_id = format!("chunk-{:06}", manifest.next_chunk_id);
    manifest.next_chunk_id += 1;
    let path = occurrences_dir(app)?.join(format!("{chunk_id}.bin"));
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    for item in items {
        let occurrence = FileOccurrence {
            item: item.clone(),
            source_id: source_id.to_string(),
            generation,
        };
        writeln!(
            file,
            "{}",
            serde_json::to_string(&occurrence).map_err(|error| error.to_string())?
        )
        .map_err(|error| error.to_string())?;
    }
    manifest.chunks.push(FileCatalogChunk {
        id: chunk_id,
        source_id: source_id.to_string(),
        generation,
        count: items.len(),
        created_at: current_timestamp_millis(),
        active: true,
    });
    manifest.occurrence_count += items.len();
    bump_catalog_epoch(app, &mut manifest)?;
    Ok(items.len())
}

#[tauri::command]
fn init_catalog(app: AppHandle) -> AppResult<CatalogInfo> {
    ensure_file_catalog_dirs(&app)?;
    let manifest = load_file_catalog_manifest(&app)?;
    save_file_catalog_manifest(&app, &manifest)?;
    Ok(CatalogInfo {
        storage_mode: "native".to_string(),
        filename: catalog_dir(&app)?.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn upsert_source(app: AppHandle, source: MediaSource) -> AppResult<()> {
    let mut manifest = load_file_catalog_manifest(&app)?;
    let generation = manifest
        .sources
        .get(&source.id)
        .map(|existing| existing.generation)
        .unwrap_or(1);
    manifest.sources.insert(
        source.id.clone(),
        FileCatalogSource {
            id: source.id,
            label: source.label,
            root_path: source.root_path,
            generation,
            active: true,
            imported_at: current_timestamp_millis(),
        },
    );
    save_file_catalog_manifest(&app, &manifest)
}

#[tauri::command]
fn upsert_media(app: AppHandle, items: Vec<MediaItem>) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    let source = MediaSource {
        id: items[0].source_id.clone(),
        label: items[0].source_id.clone(),
        root_path: items
            .iter()
            .flat_map(|item| item.locations.iter())
            .find_map(|location| location.root_path.clone()),
    };
    let generation = prepare_import_source(&app, &source)?;
    let written = append_media_items(&app, &source.id, generation, &items)?;
    let mut manifest = load_file_catalog_manifest(&app)?;
    materialize_file_catalog(&app, &mut manifest)?;
    Ok(written)
}

#[tauri::command]
fn list_media(app: AppHandle, query: CatalogQuery) -> AppResult<Vec<MediaItem>> {
    let mut items = active_media_items(&app)?
        .into_iter()
        .filter(|item| item_matches_catalog_query(item, &query))
        .map(|item| {
            normalize_media_item(
                item.clone(),
                filtered_locations(&item, &query),
                query.source_id.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    sort_media_items(&mut items, &query.sort);
    let offset = query.offset.unwrap_or(0).max(0) as usize;
    let limit = query.limit.unwrap_or(500).clamp(1, 10_000) as usize;
    Ok(items.into_iter().skip(offset).take(limit).collect())
}

fn item_matches_catalog_query(item: &MediaItem, query: &CatalogQuery) -> bool {
    match query.kind.as_deref() {
        None | Some("all") => {}
        Some("media") if matches!(item.kind.as_str(), "image" | "video") => {}
        Some(kind) if item.kind == kind => {}
        _ => return false,
    }
    if let Some(source_id) = query.source_id.as_ref() {
        if !item
            .locations
            .iter()
            .any(|location| &location.source_id == source_id)
        {
            return false;
        }
    }
    if let Some(has_geo) = query.has_geo {
        let item_has_geo = item.latitude.is_some() && item.longitude.is_some();
        if item_has_geo != has_geo {
            return false;
        }
    }
    if let Some(bounds) = query.geo_bounds.as_ref() {
        let Some(lat) = item.latitude else {
            return false;
        };
        let Some(lon) = item.longitude else {
            return false;
        };
        if lat < bounds.min_lat
            || lat > bounds.max_lat
            || lon < bounds.min_lon
            || lon > bounds.max_lon
        {
            return false;
        }
    }
    let Some(item_start_time) = item.timestamp else {
        return query.start_time.is_none() && query.end_time.is_none();
    };
    let item_end_time = item.end_timestamp.unwrap_or(item_start_time);
    if let Some(start_time) = query.start_time {
        if item_end_time < start_time {
            return false;
        }
    }
    if let Some(end_time) = query.end_time {
        if item_start_time > end_time {
            return false;
        }
    }
    true
}

fn filtered_locations(item: &MediaItem, query: &CatalogQuery) -> Vec<MediaLocation> {
    if let Some(source_id) = query.source_id.as_ref() {
        let locations = item
            .locations
            .iter()
            .filter(|location| &location.source_id == source_id)
            .cloned()
            .collect::<Vec<_>>();
        if !locations.is_empty() {
            return locations;
        }
    }
    item.locations.clone()
}

fn sort_media_items(items: &mut [MediaItem], sort: &str) {
    items.sort_by(|a, b| {
        let time_order = match sort {
            "timestamp_asc" => a.timestamp.cmp(&b.timestamp),
            _ => b.timestamp.cmp(&a.timestamp),
        };
        time_order.then_with(|| a.content_hash.cmp(&b.content_hash))
    });
}

#[derive(Clone, Copy)]
struct NativePackedIndexRecord {
    timestamp_sec: u32,
    lat_e7: i32,
    lon_e7: i32,
    asset_id: usize,
    kind_flags: u8,
    source_code: u8,
    quality_flags: u16,
    accuracy_meters: f32,
    velocity_meters_per_second: f32,
    heading_degrees: f32,
    group_hash: u64,
    sequence: i32,
}

struct NativePackedIndexHeader {
    catalog_version: i64,
    entry_count: usize,
    index_size_bytes: usize,
}

fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u16_le(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_f32_le(bytes: &mut [u8], offset: usize, value: f32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_f64_le(bytes: &mut [u8], offset: usize, value: f64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn write_i32_le(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64_le(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes(slice.try_into().ok()?))
}

fn read_u64_le(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    Some(u64::from_le_bytes(slice.try_into().ok()?))
}

fn read_i32_le(bytes: &[u8], offset: usize) -> Option<i32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(i32::from_le_bytes(slice.try_into().ok()?))
}

fn read_f64_le(bytes: &[u8], offset: usize) -> Option<f64> {
    let slice = bytes.get(offset..offset + 8)?;
    Some(f64::from_le_bytes(slice.try_into().ok()?))
}

fn read_f32_le(bytes: &[u8], offset: usize) -> Option<f32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(f32::from_le_bytes(slice.try_into().ok()?))
}

fn timestamp_seconds(value: i64) -> u32 {
    (value / 1000).clamp(0, u32::MAX as i64) as u32
}

fn lat_e7(value: f64) -> i32 {
    (value.clamp(-90.0, 90.0) * 10_000_000.0).round() as i32
}

fn lon_e7(value: f64) -> i32 {
    (value.clamp(-180.0, 180.0) * 10_000_000.0).round() as i32
}

fn coordinate_from_e7(value: i32) -> f64 {
    value as f64 / 10_000_000.0
}

fn kind_flags(item: &MediaItem) -> u8 {
    let kind = match item.kind.as_str() {
        "video" => KIND_CODE_VIDEO,
        "geo_point" => KIND_CODE_GEO_POINT,
        "timeline_visit" => KIND_CODE_TIMELINE_VISIT,
        "timeline_activity" => KIND_CODE_TIMELINE_ACTIVITY,
        "activity_sample" => KIND_CODE_ACTIVITY_SAMPLE,
        "frequent_place" => KIND_CODE_FREQUENT_PLACE,
        _ => KIND_CODE_IMAGE,
    };
    kind | if item.latitude.is_some() && item.longitude.is_some() {
        KIND_FLAG_HAS_GEO
    } else {
        0
    }
}

fn source_code_from_value(value: Option<&str>) -> u8 {
    let Some(value) = value else {
        return LINE_SOURCE_UNKNOWN;
    };
    match value.trim().to_ascii_uppercase().as_str() {
        "GPS" => LINE_SOURCE_GPS,
        "WIFI" | "WI_FI" => LINE_SOURCE_WIFI,
        "CELL" | "CELLULAR" => LINE_SOURCE_CELL,
        _ => LINE_SOURCE_UNKNOWN,
    }
}

fn source_code_from_item(item: &MediaItem) -> u8 {
    let source_type = source_code_from_value(item.source_type.as_deref());
    if source_type != LINE_SOURCE_UNKNOWN {
        return source_type;
    }
    item.metadata
        .as_ref()
        .and_then(|metadata| metadata.get("source"))
        .and_then(|source| source.as_str())
        .map(|source| source_code_from_value(Some(source)))
        .unwrap_or(LINE_SOURCE_UNKNOWN)
}

fn line_source_from_code(code: u8) -> &'static str {
    match code {
        LINE_SOURCE_GPS => "GPS",
        LINE_SOURCE_WIFI => "WIFI",
        LINE_SOURCE_CELL => "CELL",
        _ => "UNKNOWN",
    }
}

fn hash_string_64(value: Option<&str>) -> u64 {
    let Some(value) = value else {
        return 0;
    };
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn line_payload_from_item(item: &MediaItem) -> (u8, u16, f32, f32, f32, u64, i32) {
    let mut quality_flags = 0_u16;
    if item.accuracy_meters.is_some() {
        quality_flags |= LINE_QUALITY_HAS_ACCURACY;
    }
    if item.velocity_meters_per_second.is_some() {
        quality_flags |= LINE_QUALITY_HAS_VELOCITY;
    }
    if item.heading_degrees.is_some() {
        quality_flags |= LINE_QUALITY_HAS_HEADING;
    }
    let group_hash = hash_string_64(item.group_id.as_deref());
    if group_hash != 0 {
        quality_flags |= LINE_QUALITY_HAS_GROUP;
    }
    if item.sequence.is_some() {
        quality_flags |= LINE_QUALITY_HAS_SEQUENCE;
    }
    (
        source_code_from_item(item),
        quality_flags,
        item.accuracy_meters.unwrap_or(f64::NAN) as f32,
        item.velocity_meters_per_second.unwrap_or(f64::NAN) as f32,
        item.heading_degrees.unwrap_or(f64::NAN) as f32,
        group_hash,
        item.sequence
            .unwrap_or(-1)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    )
}

fn kind_matches_flags(flags: u8, kind: Option<&str>) -> bool {
    let Some(kind) = kind else {
        return true;
    };
    if kind == "all" {
        return true;
    }
    let encoded = flags & KIND_CODE_MASK;
    match kind {
        "media" => matches!(encoded, KIND_CODE_IMAGE | KIND_CODE_VIDEO),
        "image" => encoded == KIND_CODE_IMAGE,
        "video" => encoded == KIND_CODE_VIDEO,
        "geo_point" => encoded == KIND_CODE_GEO_POINT,
        "timeline_visit" => encoded == KIND_CODE_TIMELINE_VISIT,
        "timeline_activity" => encoded == KIND_CODE_TIMELINE_ACTIVITY,
        "activity_sample" => encoded == KIND_CODE_ACTIVITY_SAMPLE,
        "frequent_place" => encoded == KIND_CODE_FREQUENT_PLACE,
        _ => false,
    }
}

fn kind_from_flags(flags: u8) -> String {
    match flags & KIND_CODE_MASK {
        KIND_CODE_VIDEO => "video",
        KIND_CODE_GEO_POINT => "geo_point",
        KIND_CODE_TIMELINE_VISIT => "timeline_visit",
        KIND_CODE_TIMELINE_ACTIVITY => "timeline_activity",
        KIND_CODE_ACTIVITY_SAMPLE => "activity_sample",
        KIND_CODE_FREQUENT_PLACE => "frequent_place",
        _ => "image",
    }
    .to_string()
}

fn query_may_match_interval_kinds(kind: Option<&str>) -> bool {
    matches!(
        kind,
        None | Some("all") | Some("timeline_visit") | Some("timeline_activity")
    )
}

fn scan_min_timestamp_sec(query: &CatalogQuery) -> u32 {
    match query.start_time {
        None => 0,
        Some(_) if query_may_match_interval_kinds(query.kind.as_deref()) => 0,
        Some(value) => timestamp_seconds(value),
    }
}

fn packed_record_matches_query(record: NativePackedIndexRecord, query: &CatalogQuery) -> bool {
    if !kind_matches_flags(record.kind_flags, query.kind.as_deref()) {
        return false;
    }
    let has_geo = record.kind_flags & KIND_FLAG_HAS_GEO != 0;
    if let Some(required) = query.has_geo {
        if required != has_geo {
            return false;
        }
    }
    if let Some(bounds) = query.geo_bounds.as_ref() {
        if !has_geo {
            return false;
        }
        let lat = coordinate_from_e7(record.lat_e7);
        let lon = coordinate_from_e7(record.lon_e7);
        if lat < bounds.min_lat
            || lat > bounds.max_lat
            || lon < bounds.min_lon
            || lon > bounds.max_lon
        {
            return false;
        }
    }
    true
}

fn packed_index_header_from_bytes(
    bytes: &[u8],
    expected_kind: u32,
) -> Option<NativePackedIndexHeader> {
    if bytes.len() < PACKED_INDEX_HEADER_SIZE {
        return None;
    }
    if read_u32_le(&bytes, 0)? != PACKED_INDEX_MAGIC {
        return None;
    }
    if read_u32_le(&bytes, 4)? != BINARY_SCHEMA_VERSION {
        return None;
    }
    if read_u32_le(&bytes, 40)? != expected_kind {
        return None;
    }
    if read_u32_le(&bytes, 36)? as usize != TIME_GEO_RECORD_SIZE {
        return None;
    }
    Some(NativePackedIndexHeader {
        catalog_version: read_f64_le(&bytes, 8)? as i64,
        entry_count: read_f64_le(&bytes, 24)? as usize,
        index_size_bytes: bytes.len(),
    })
}

fn packed_index_header(path: &Path, expected_kind: u32) -> Option<NativePackedIndexHeader> {
    let bytes = fs::read(path).ok()?;
    packed_index_header_from_bytes(&bytes, expected_kind)
}

fn read_packed_index_bytes(
    path: &Path,
    expected_kind: u32,
) -> AppResult<(NativePackedIndexHeader, Vec<u8>)> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let header = packed_index_header_from_bytes(&bytes, expected_kind)
        .ok_or_else(|| "Catalog index file is missing or invalid.".to_string())?;
    Ok((header, bytes))
}

fn packed_record_at(bytes: &[u8], index: usize) -> Option<NativePackedIndexRecord> {
    let offset = PACKED_INDEX_HEADER_SIZE + index * TIME_GEO_RECORD_SIZE;
    Some(NativePackedIndexRecord {
        timestamp_sec: read_u32_le(bytes, offset)?,
        lat_e7: read_i32_le(bytes, offset + 4)?,
        lon_e7: read_i32_le(bytes, offset + 8)?,
        asset_id: read_u32_le(bytes, offset + 12)? as usize,
        kind_flags: bytes.get(offset + 16).copied()?,
        source_code: bytes.get(offset + 17).copied()?,
        quality_flags: read_u16_le(bytes, offset + 18)?,
        accuracy_meters: read_f32_le(bytes, offset + 20)?,
        velocity_meters_per_second: read_f32_le(bytes, offset + 24)?,
        heading_degrees: read_f32_le(bytes, offset + 28)?,
        group_hash: read_u64_le(bytes, offset + 32)?,
        sequence: read_i32_le(bytes, offset + 40)?,
    })
}

fn packed_timestamp_at(bytes: &[u8], index: usize) -> Option<u32> {
    read_u32_le(
        bytes,
        PACKED_INDEX_HEADER_SIZE + index * TIME_GEO_RECORD_SIZE,
    )
}

fn packed_lower_bound(
    bytes: &[u8],
    entry_count: usize,
    mut is_before_target: impl FnMut(u32) -> bool,
) -> usize {
    let mut low = 0_usize;
    let mut high = entry_count;
    while low < high {
        let middle = (low + high) / 2;
        let Some(timestamp_sec) = packed_timestamp_at(bytes, middle) else {
            break;
        };
        if is_before_target(timestamp_sec) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn write_packed_index_file(
    path: &Path,
    kind: u32,
    manifest: &FileCatalogManifest,
    records: &mut [NativePackedIndexRecord],
) -> AppResult<()> {
    records.sort_by(|a, b| {
        a.timestamp_sec
            .cmp(&b.timestamp_sec)
            .then_with(|| a.asset_id.cmp(&b.asset_id))
    });
    let record_size = TIME_GEO_RECORD_SIZE;
    let mut bytes = Vec::with_capacity(PACKED_INDEX_HEADER_SIZE + records.len() * record_size);
    let mut header = vec![0_u8; PACKED_INDEX_HEADER_SIZE];
    write_u32_le(&mut header, 0, PACKED_INDEX_MAGIC);
    write_u32_le(&mut header, 4, BINARY_SCHEMA_VERSION);
    write_f64_le(&mut header, 8, manifest.catalog_version as f64);
    write_f64_le(&mut header, 16, manifest.asset_count as f64);
    write_f64_le(&mut header, 24, records.len() as f64);
    write_u32_le(&mut header, 32, 0);
    write_u32_le(&mut header, 36, record_size as u32);
    write_u32_le(&mut header, 40, kind);
    write_u32_le(&mut header, 44, 0);
    write_u32_le(&mut header, 48, 0);
    write_f64_le(&mut header, 56, PACKED_INDEX_HEADER_SIZE as f64);
    write_f64_le(&mut header, 80, manifest.index_applied_version as f64);
    bytes.extend_from_slice(&header);
    for record in records.iter() {
        let mut entry_bytes = vec![0_u8; record_size];
        write_u32_le(&mut entry_bytes, 0, record.timestamp_sec);
        write_i32_le(&mut entry_bytes, 4, record.lat_e7);
        write_i32_le(&mut entry_bytes, 8, record.lon_e7);
        write_u32_le(&mut entry_bytes, 12, record.asset_id as u32);
        entry_bytes[16] = record.kind_flags;
        entry_bytes[17] = record.source_code;
        write_u16_le(&mut entry_bytes, 18, record.quality_flags);
        write_f32_le(&mut entry_bytes, 20, record.accuracy_meters);
        write_f32_le(&mut entry_bytes, 24, record.velocity_meters_per_second);
        write_f32_le(&mut entry_bytes, 28, record.heading_degrees);
        write_u64_le(&mut entry_bytes, 32, record.group_hash);
        write_i32_le(&mut entry_bytes, 40, record.sequence);
        bytes.extend_from_slice(&entry_bytes);
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn file_search_engine(spec: &SearchSpec) -> AppResult<(&'static str, &'static str)> {
    let selected = spec.order.engine_id.as_deref().unwrap_or("file-time-geo");
    match selected {
        "file-time-geo" => Ok(("file-time-geo", "Time-first packed index")),
        _ => Err(format!("Search index \"{selected}\" is not available.")),
    }
}

fn scan_packed_asset_ids(
    app: &AppHandle,
    query: &CatalogQuery,
    limit: usize,
) -> AppResult<(Vec<usize>, usize, usize, usize, bool)> {
    let indexes_dir = catalog_indexes_dir(app)?;
    let (header, bytes) = read_packed_index_bytes(
        &indexes_dir.join(FILE_CATALOG_TIME_GEO_INDEX),
        INDEX_KIND_TIME_GEO,
    )?;
    if limit == 0 {
        return Ok((Vec::new(), 0, header.index_size_bytes, 0, false));
    }
    let min_time = scan_min_timestamp_sec(query);
    let max_time = query.end_time.map(timestamp_seconds).unwrap_or(u32::MAX);
    let start = packed_lower_bound(&bytes, header.entry_count, |timestamp| timestamp < min_time);
    let end = packed_lower_bound(&bytes, header.entry_count, |timestamp| {
        timestamp <= max_time
    });
    let max_asset_ids = limit.saturating_add(1);
    let mut asset_ids = Vec::<usize>::new();
    let mut pages_read = 0_usize;
    let mut inspected = 0_usize;

    if query.sort != "timestamp_asc" {
        let mut chunk_end = end;
        while chunk_end > start {
            let count = PACKED_SCAN_RECORDS.min(chunk_end - start);
            let chunk_start = chunk_end - count;
            pages_read += 1;
            for index in (chunk_start..chunk_end).rev() {
                inspected += 1;
                let Some(record) = packed_record_at(&bytes, index) else {
                    continue;
                };
                if !packed_record_matches_query(record, query) {
                    continue;
                }
                asset_ids.push(record.asset_id);
                if asset_ids.len() >= max_asset_ids {
                    asset_ids.truncate(limit);
                    return Ok((
                        asset_ids,
                        pages_read,
                        header.index_size_bytes,
                        inspected,
                        true,
                    ));
                }
            }
            chunk_end = chunk_start;
        }
    } else {
        let mut chunk_start = start;
        while chunk_start < end {
            let chunk_end = (chunk_start + PACKED_SCAN_RECORDS).min(end);
            pages_read += 1;
            for index in chunk_start..chunk_end {
                inspected += 1;
                let Some(record) = packed_record_at(&bytes, index) else {
                    continue;
                };
                if !packed_record_matches_query(record, query) {
                    continue;
                }
                asset_ids.push(record.asset_id);
                if asset_ids.len() >= max_asset_ids {
                    asset_ids.truncate(limit);
                    return Ok((
                        asset_ids,
                        pages_read,
                        header.index_size_bytes,
                        inspected,
                        true,
                    ));
                }
            }
            chunk_start = chunk_end;
        }
    }

    Ok((
        asset_ids,
        pages_read,
        header.index_size_bytes,
        inspected,
        false,
    ))
}

#[derive(Clone)]
struct NativeMapPointBucket {
    cell_id: String,
    count: usize,
    sum_lat: f64,
    sum_lon: f64,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    center_lat: f64,
    center_lon: f64,
    first_point: Option<MapPoint>,
}

struct NativeMapPointAggregation {
    zoom: usize,
    world_size: f64,
    cell_size_px: f64,
    buckets: HashMap<String, NativeMapPointBucket>,
}

fn create_map_point_aggregation(
    options: Option<&MapAggregationSpec>,
    limit: usize,
) -> NativeMapPointAggregation {
    let zoom = options
        .map(|options| options.zoom.floor().clamp(0.0, 24.0) as usize)
        .unwrap_or(0);
    let viewport_width_px = options
        .map(|options| options.viewport_width_px.max(1.0))
        .unwrap_or(1024.0);
    let viewport_height_px = options
        .map(|options| options.viewport_height_px.max(1.0))
        .unwrap_or(768.0);
    let requested_cell_size_px = options
        .map(|options| options.bubble_cell_size_px.max(1.0))
        .unwrap_or(64.0);
    let budget_cell_size_px =
        ((viewport_width_px * viewport_height_px) / limit.max(1) as f64).sqrt();
    let cell_size_px = requested_cell_size_px.max(budget_cell_size_px);
    let world_size = WEB_MERCATOR_TILE_SIZE * 2_f64.powi(zoom as i32);
    NativeMapPointAggregation {
        zoom,
        world_size,
        cell_size_px,
        buckets: HashMap::new(),
    }
}

fn lon_lat_to_world_pixel(lon: f64, lat: f64, world_size: f64) -> (f64, f64) {
    let clamped_lat = lat.clamp(-WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
    let clamped_lon = lon.clamp(-180.0, 180.0);
    let sin_lat = to_radians(clamped_lat).sin();
    let x = ((clamped_lon + 180.0) / 360.0) * world_size;
    let y = (0.5 - ((1.0 + sin_lat) / (1.0 - sin_lat)).ln() / (4.0 * std::f64::consts::PI))
        * world_size;
    (x, y)
}

fn world_pixel_to_lon_lat(x: f64, y: f64, world_size: f64) -> (f64, f64) {
    let lon = (x / world_size) * 360.0 - 180.0;
    let n = std::f64::consts::PI - (2.0 * std::f64::consts::PI * y) / world_size;
    let lat = n.sinh().atan().to_degrees();
    (lat.clamp(-90.0, 90.0), lon.clamp(-180.0, 180.0))
}

#[derive(Clone)]
struct NativePolylineCandidate {
    asset_id: usize,
    kind: String,
    lat: f64,
    lon: f64,
    timestamp_sec: u32,
    source: &'static str,
    accuracy_meters: Option<f64>,
    group_key: Option<String>,
    sequence: Option<i32>,
}

struct NativePolylineCleanup {
    enabled: bool,
    allowed_sources: HashSet<String>,
    max_accuracy_meters: Option<f64>,
    break_speed_kmh: Option<f64>,
    max_segment_distance_km: Option<f64>,
    remove_isolated_jumps: bool,
    show_dots: bool,
}

struct NativeCandidateSegment {
    group_key: Option<String>,
    candidates: Vec<NativePolylineCandidate>,
}

fn normalize_polyline_cleanup(map_polyline: Option<&MapPolylineSpec>) -> NativePolylineCleanup {
    let cleanup = map_polyline.and_then(|options| options.cleanup.as_ref());
    let allowed_sources = ["GPS", "WIFI", "CELL", "UNKNOWN"]
        .iter()
        .map(|source| source.to_string())
        .collect();
    NativePolylineCleanup {
        enabled: cleanup.is_some_and(|options| options.enabled),
        allowed_sources,
        max_accuracy_meters: None,
        break_speed_kmh: cleanup
            .and_then(|options| options.break_speed_kmh.filter(|value| value.is_finite())),
        max_segment_distance_km: cleanup.and_then(|options| {
            options
                .max_segment_distance_km
                .filter(|value| value.is_finite() && *value > 0.0)
        }),
        remove_isolated_jumps: true,
        show_dots: false,
    }
}

fn record_accuracy_meters(record: NativePackedIndexRecord) -> Option<f64> {
    if record.quality_flags & LINE_QUALITY_HAS_ACCURACY == 0 {
        return None;
    }
    record
        .accuracy_meters
        .is_finite()
        .then_some(record.accuracy_meters as f64)
}

fn record_sequence(record: NativePackedIndexRecord) -> Option<i32> {
    (record.quality_flags & LINE_QUALITY_HAS_SEQUENCE != 0 && record.sequence >= 0)
        .then_some(record.sequence)
}

fn polyline_candidate_from_record(record: NativePackedIndexRecord) -> NativePolylineCandidate {
    NativePolylineCandidate {
        asset_id: record.asset_id,
        kind: kind_from_flags(record.kind_flags),
        lat: coordinate_from_e7(record.lat_e7),
        lon: coordinate_from_e7(record.lon_e7),
        timestamp_sec: record.timestamp_sec,
        source: line_source_from_code(record.source_code),
        accuracy_meters: record_accuracy_meters(record),
        group_key: (record.quality_flags & LINE_QUALITY_HAS_GROUP != 0 && record.group_hash != 0)
            .then_some(format!("{:016x}", record.group_hash)),
        sequence: record_sequence(record),
    }
}

fn candidate_passes_quality_filter(
    candidate: &NativePolylineCandidate,
    cleanup: &NativePolylineCleanup,
) -> bool {
    if !cleanup.enabled {
        return true;
    }
    if !cleanup.allowed_sources.contains(candidate.source) {
        return false;
    }
    if let (Some(max_accuracy), Some(accuracy)) =
        (cleanup.max_accuracy_meters, candidate.accuracy_meters)
    {
        if accuracy > max_accuracy {
            return false;
        }
    }
    true
}

fn map_point_from_candidate(candidate: &NativePolylineCandidate) -> MapPoint {
    MapPoint {
        media_id: None,
        asset_id: Some(candidate.asset_id),
        cell_id: None,
        kind: Some(candidate.kind.clone()),
        lat: candidate.lat,
        lon: candidate.lon,
        timestamp: Some(candidate.timestamp_sec as i64 * 1000),
        count: Some(1),
        bounds: None,
    }
}

fn candidate_speed_kmh(left: &NativePolylineCandidate, right: &NativePolylineCandidate) -> f64 {
    let seconds = right.timestamp_sec.saturating_sub(left.timestamp_sec);
    if seconds == 0 {
        return 0.0;
    }
    distance_between_coords(left.lat, left.lon, right.lat, right.lon) / seconds as f64 * 3.6
}

fn remove_isolated_jump_candidates(
    candidates: &[NativePolylineCandidate],
    break_speed_kmh: Option<f64>,
) -> (Vec<NativePolylineCandidate>, usize) {
    let Some(break_speed_kmh) = break_speed_kmh else {
        return (candidates.to_vec(), 0);
    };
    if candidates.len() < 3 {
        return (candidates.to_vec(), 0);
    }
    let mut kept = Vec::<NativePolylineCandidate>::with_capacity(candidates.len());
    kept.push(candidates[0].clone());
    let mut removed = 0_usize;
    for index in 1..candidates.len() - 1 {
        let previous = &candidates[index - 1];
        let current = &candidates[index];
        let next = &candidates[index + 1];
        if candidate_speed_kmh(previous, current) > break_speed_kmh
            && candidate_speed_kmh(current, next) > break_speed_kmh
            && candidate_speed_kmh(previous, next) <= break_speed_kmh
        {
            removed += 1;
            continue;
        }
        kept.push(current.clone());
    }
    kept.push(candidates[candidates.len() - 1].clone());
    (kept, removed)
}

fn split_candidates_by_speed(
    candidates: &[NativePolylineCandidate],
    break_speed_kmh: Option<f64>,
) -> (Vec<Vec<NativePolylineCandidate>>, usize) {
    let Some(break_speed_kmh) = break_speed_kmh else {
        return (vec![candidates.to_vec()], 0);
    };
    if candidates.is_empty() {
        return (Vec::new(), 0);
    }
    let mut segments = Vec::<Vec<NativePolylineCandidate>>::new();
    let mut current = vec![candidates[0].clone()];
    let mut breaks = 0_usize;
    for index in 1..candidates.len() {
        let candidate = candidates[index].clone();
        if candidate_speed_kmh(&candidates[index - 1], &candidate) > break_speed_kmh {
            segments.push(current);
            current = vec![candidate];
            breaks += 1;
        } else {
            current.push(candidate);
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    (segments, breaks)
}

fn split_candidates_by_max_segment_distance(
    candidates: &[NativePolylineCandidate],
    max_segment_distance_km: Option<f64>,
) -> (Vec<Vec<NativePolylineCandidate>>, usize) {
    let Some(max_segment_distance_km) = max_segment_distance_km else {
        return (vec![candidates.to_vec()], 0);
    };
    if candidates.is_empty() {
        return (Vec::new(), 0);
    }
    if candidates.len() < 2 {
        return (vec![candidates.to_vec()], 0);
    }
    let max_segment_distance_meters = max_segment_distance_km * 1000.0;
    let mut segments = Vec::<Vec<NativePolylineCandidate>>::new();
    let mut current = vec![candidates[0].clone()];
    let mut breaks = 0_usize;
    for index in 1..candidates.len() {
        let candidate = candidates[index].clone();
        let previous = &candidates[index - 1];
        if distance_between_coords(previous.lat, previous.lon, candidate.lat, candidate.lon)
            > max_segment_distance_meters
        {
            segments.push(current);
            current = vec![candidate];
            breaks += 1;
        } else {
            current.push(candidate);
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    (segments, breaks)
}

fn flush_sequence_run(
    group_key: &str,
    run: Vec<NativePolylineCandidate>,
    line_segments: &mut Vec<NativeCandidateSegment>,
    dot_points: &mut Vec<MapPoint>,
) {
    if run.len() >= 2 {
        line_segments.push(NativeCandidateSegment {
            group_key: Some(group_key.to_string()),
            candidates: run,
        });
    } else if let Some(candidate) = run.first() {
        dot_points.push(map_point_from_candidate(candidate));
    }
}

fn split_group_by_consecutive_sequence(
    group_key: &str,
    mut candidates: Vec<NativePolylineCandidate>,
) -> (Vec<NativeCandidateSegment>, Vec<MapPoint>) {
    candidates.sort_by(|left, right| {
        left.sequence
            .unwrap_or(i32::MAX)
            .cmp(&right.sequence.unwrap_or(i32::MAX))
            .then_with(|| left.timestamp_sec.cmp(&right.timestamp_sec))
            .then_with(|| left.asset_id.cmp(&right.asset_id))
    });
    let mut line_segments = Vec::<NativeCandidateSegment>::new();
    let mut dot_points = Vec::<MapPoint>::new();
    let mut current_run = Vec::<NativePolylineCandidate>::new();

    for candidate in candidates {
        let Some(sequence) = candidate.sequence else {
            flush_sequence_run(group_key, current_run, &mut line_segments, &mut dot_points);
            current_run = Vec::new();
            dot_points.push(map_point_from_candidate(&candidate));
            continue;
        };

        if current_run
            .last()
            .and_then(|previous| previous.sequence)
            .is_some_and(|previous_sequence| sequence != previous_sequence + 1)
        {
            flush_sequence_run(group_key, current_run, &mut line_segments, &mut dot_points);
            current_run = Vec::new();
        }
        current_run.push(candidate);
    }

    flush_sequence_run(group_key, current_run, &mut line_segments, &mut dot_points);
    (line_segments, dot_points)
}

fn polyline_from_candidate_segments(
    candidate_segments: &[NativeCandidateSegment],
    requested_tolerance_px: f64,
    _max_points: usize,
) -> MapPolyline {
    let source_point_count = candidate_segments
        .iter()
        .map(|segment| segment.candidates.len())
        .sum::<usize>();
    let non_empty_segments = candidate_segments
        .iter()
        .filter(|segment| segment.candidates.len() >= 2)
        .collect::<Vec<_>>();
    if non_empty_segments.is_empty() {
        return MapPolyline {
            points: Vec::new(),
            segments: Some(Vec::new()),
            bounds: None,
            source_point_count,
            simplified_point_count: 0,
            tolerance_px: requested_tolerance_px.max(0.0),
        };
    }

    let mut rendered_segments = Vec::<MapPolylineSegment>::new();
    let mut flattened = Vec::<MapPolylinePoint>::new();
    for segment in &non_empty_segments {
        let points = segment
            .candidates
            .iter()
            .map(|candidate| MapPolylinePoint {
                lat: candidate.lat,
                lon: candidate.lon,
            })
            .collect::<Vec<_>>();
        if points.len() >= 2 {
            flattened.extend(points.iter().cloned());
            rendered_segments.push(MapPolylineSegment {
                points,
                group_key: segment.group_key.clone(),
            });
        }
    }

    let bounds = (!flattened.is_empty()).then(|| {
        flattened.iter().fold(
            GeoBounds {
                min_lat: f64::INFINITY,
                max_lat: f64::NEG_INFINITY,
                min_lon: f64::INFINITY,
                max_lon: f64::NEG_INFINITY,
            },
            |bounds, point| GeoBounds {
                min_lat: bounds.min_lat.min(point.lat),
                max_lat: bounds.max_lat.max(point.lat),
                min_lon: bounds.min_lon.min(point.lon),
                max_lon: bounds.max_lon.max(point.lon),
            },
        )
    });

    MapPolyline {
        points: flattened.clone(),
        segments: Some(rendered_segments),
        bounds,
        source_point_count,
        simplified_point_count: flattened.len(),
        tolerance_px: requested_tolerance_px.max(0.0),
    }
}

fn map_point_bucket(
    aggregation: &NativeMapPointAggregation,
    point: &MapPoint,
) -> (String, f64, f64) {
    let (pixel_x, pixel_y) = lon_lat_to_world_pixel(point.lon, point.lat, aggregation.world_size);
    let cells_per_row = (aggregation.world_size / aggregation.cell_size_px)
        .ceil()
        .max(1.0) as usize;
    let cell_x = ((pixel_x / aggregation.cell_size_px).floor().max(0.0) as usize)
        .min(cells_per_row.saturating_sub(1));
    let cell_y = ((pixel_y / aggregation.cell_size_px).floor().max(0.0) as usize)
        .min(cells_per_row.saturating_sub(1));
    let (center_lat, center_lon) = world_pixel_to_lon_lat(
        (cell_x as f64 + 0.5) * aggregation.cell_size_px,
        (cell_y as f64 + 0.5) * aggregation.cell_size_px,
        aggregation.world_size,
    );
    (
        format!("{}/{}/{}", aggregation.zoom, cell_x, cell_y),
        center_lat,
        center_lon,
    )
}

fn add_map_point_to_aggregation(
    aggregation: &mut NativeMapPointAggregation,
    point: MapPoint,
) -> usize {
    let (cell_id, center_lat, center_lon) = map_point_bucket(aggregation, &point);
    if let Some(bucket) = aggregation.buckets.get_mut(&cell_id) {
        bucket.count += 1;
        bucket.sum_lat += point.lat;
        bucket.sum_lon += point.lon;
        bucket.min_lat = bucket.min_lat.min(point.lat);
        bucket.max_lat = bucket.max_lat.max(point.lat);
        bucket.min_lon = bucket.min_lon.min(point.lon);
        bucket.max_lon = bucket.max_lon.max(point.lon);
        return bucket.count;
    }

    aggregation.buckets.insert(
        cell_id.clone(),
        NativeMapPointBucket {
            cell_id,
            count: 1,
            sum_lat: point.lat,
            sum_lon: point.lon,
            min_lat: point.lat,
            max_lat: point.lat,
            min_lon: point.lon,
            max_lon: point.lon,
            center_lat,
            center_lon,
            first_point: Some(point),
        },
    );
    1
}

fn aggregated_map_points(aggregation: NativeMapPointAggregation) -> Vec<MapPoint> {
    aggregation
        .buckets
        .into_values()
        .map(|bucket| {
            if bucket.count == 1 {
                if let Some(point) = bucket.first_point {
                    return MapPoint {
                        cell_id: Some(bucket.cell_id),
                        count: Some(1),
                        bounds: Some(GeoBounds {
                            min_lat: bucket.min_lat,
                            max_lat: bucket.max_lat,
                            min_lon: bucket.min_lon,
                            max_lon: bucket.max_lon,
                        }),
                        ..point
                    };
                }
            }
            MapPoint {
                media_id: None,
                asset_id: None,
                cell_id: Some(bucket.cell_id),
                kind: None,
                lat: bucket.center_lat,
                lon: bucket.center_lon,
                timestamp: None,
                count: Some(bucket.count),
                bounds: Some(GeoBounds {
                    min_lat: bucket.min_lat,
                    max_lat: bucket.max_lat,
                    min_lon: bucket.min_lon,
                    max_lon: bucket.max_lon,
                }),
            }
        })
        .collect()
}

fn visit_packed_map_record(
    record: NativePackedIndexRecord,
    query: &CatalogQuery,
    aggregation: &mut NativeMapPointAggregation,
) -> Option<usize> {
    if !packed_record_matches_query(record, query) {
        return None;
    }
    let point = MapPoint {
        media_id: None,
        asset_id: Some(record.asset_id),
        cell_id: None,
        kind: Some(kind_from_flags(record.kind_flags)),
        lat: coordinate_from_e7(record.lat_e7),
        lon: coordinate_from_e7(record.lon_e7),
        timestamp: Some(record.timestamp_sec as i64 * 1000),
        count: None,
        bounds: None,
    };
    Some(add_map_point_to_aggregation(aggregation, point))
}

fn scan_packed_map_points(
    app: &AppHandle,
    query: &CatalogQuery,
    map_aggregation: Option<&MapAggregationSpec>,
    limit: usize,
    _offset: usize,
) -> AppResult<(
    MapPointPage,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    f64,
)> {
    let indexes_dir = catalog_indexes_dir(app)?;
    let (header, bytes) = read_packed_index_bytes(
        &indexes_dir.join(FILE_CATALOG_TIME_GEO_INDEX),
        INDEX_KIND_TIME_GEO,
    )?;
    let min_time = scan_min_timestamp_sec(query);
    let max_time = query.end_time.map(timestamp_seconds).unwrap_or(u32::MAX);
    let start = packed_lower_bound(&bytes, header.entry_count, |timestamp| timestamp < min_time);
    let end = packed_lower_bound(&bytes, header.entry_count, |timestamp| {
        timestamp <= max_time
    });
    let mut matched_records = 0_usize;
    let mut largest_bubble_count = 0_usize;
    let mut pages_read = 0_usize;
    let mut candidates_inspected = 0_usize;
    let disk_read_bytes = bytes.len();
    let mut aggregation = create_map_point_aggregation(map_aggregation, limit);

    if query.sort != "timestamp_asc" {
        let mut chunk_end = end;
        while chunk_end > start {
            let count = PACKED_SCAN_RECORDS.min(chunk_end - start);
            let chunk_start = chunk_end - count;
            pages_read += 1;
            for index in (chunk_start..chunk_end).rev() {
                candidates_inspected += 1;
                if let Some(record) = packed_record_at(&bytes, index) {
                    if let Some(bucket_count) =
                        visit_packed_map_record(record, query, &mut aggregation)
                    {
                        matched_records += 1;
                        largest_bubble_count = largest_bubble_count.max(bucket_count);
                    }
                }
            }
            chunk_end = chunk_start;
        }
    } else {
        let mut chunk_start = start;
        while chunk_start < end {
            let chunk_end = (chunk_start + PACKED_SCAN_RECORDS).min(end);
            pages_read += 1;
            for index in chunk_start..chunk_end {
                candidates_inspected += 1;
                if let Some(record) = packed_record_at(&bytes, index) {
                    if let Some(bucket_count) =
                        visit_packed_map_record(record, query, &mut aggregation)
                    {
                        matched_records += 1;
                        largest_bubble_count = largest_bubble_count.max(bucket_count);
                    }
                }
            }
            chunk_start = chunk_end;
        }
    }

    let aggregation_zoom = aggregation.zoom;
    let aggregation_cell_size_px = aggregation.cell_size_px;
    let mut points = aggregated_map_points(aggregation);
    let limit_reached = points.len() > limit;
    if limit_reached {
        points.sort_by(|left, right| (right.count.unwrap_or(1)).cmp(&left.count.unwrap_or(1)));
        points.truncate(limit);
    }
    let rendered_bubbles = points.len();

    Ok((
        MapPointPage {
            points,
            polyline: None,
            limit_reached: Some(limit_reached),
            result_metrics: None,
        },
        pages_read,
        disk_read_bytes,
        candidates_inspected,
        matched_records,
        rendered_bubbles,
        largest_bubble_count,
        aggregation_zoom,
        aggregation_cell_size_px,
    ))
}

fn scan_packed_map_polyline(
    app: &AppHandle,
    query: &CatalogQuery,
    _map_aggregation: Option<&MapAggregationSpec>,
    map_polyline: Option<&MapPolylineSpec>,
) -> AppResult<(
    MapPointPage,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    f64,
)> {
    let indexes_dir = catalog_indexes_dir(app)?;
    let (header, bytes) = read_packed_index_bytes(
        &indexes_dir.join(FILE_CATALOG_TIME_GEO_INDEX),
        INDEX_KIND_TIME_GEO,
    )?;
    let min_time = scan_min_timestamp_sec(query);
    let max_time = query.end_time.map(timestamp_seconds).unwrap_or(u32::MAX);
    let start = packed_lower_bound(&bytes, header.entry_count, |timestamp| timestamp < min_time);
    let end = packed_lower_bound(&bytes, header.entry_count, |timestamp| {
        timestamp <= max_time
    });
    let max_points = map_polyline
        .map(|options| options.max_points)
        .unwrap_or(10_000)
        .clamp(2, 100_000);
    let requested_tolerance_px = map_polyline
        .map(|options| options.tolerance_px.max(0.0))
        .unwrap_or(2.0);
    let cleanup = normalize_polyline_cleanup(map_polyline);
    let mut grouped_line_candidates = HashMap::<String, Vec<NativePolylineCandidate>>::new();
    let mut dot_points = Vec::<MapPoint>::new();
    let mut matched_records = 0_usize;
    let mut filtered_quality_points = 0_usize;
    let mut pages_read = 0_usize;
    let mut candidates_inspected = 0_usize;
    let disk_read_bytes = bytes.len();

    let mut accept_record = |record: NativePackedIndexRecord| {
        matched_records += 1;
        let candidate = polyline_candidate_from_record(record);
        if !candidate_passes_quality_filter(&candidate, &cleanup) {
            filtered_quality_points += 1;
            return;
        }
        if let Some(group_key) = candidate.group_key.clone() {
            grouped_line_candidates
                .entry(group_key)
                .or_default()
                .push(candidate);
        } else if cleanup.show_dots {
            dot_points.push(map_point_from_candidate(&candidate));
            return;
        }
    };

    if query.sort != "timestamp_asc" {
        let mut chunk_end = end;
        while chunk_end > start {
            let count = PACKED_SCAN_RECORDS.min(chunk_end - start);
            let chunk_start = chunk_end - count;
            pages_read += 1;
            for index in (chunk_start..chunk_end).rev() {
                candidates_inspected += 1;
                let Some(record) = packed_record_at(&bytes, index) else {
                    continue;
                };
                if !packed_record_matches_query(record, query) {
                    continue;
                }
                accept_record(record);
            }
            chunk_end = chunk_start;
        }
    } else {
        let mut chunk_start = start;
        while chunk_start < end {
            let chunk_end = (chunk_start + PACKED_SCAN_RECORDS).min(end);
            pages_read += 1;
            for index in chunk_start..chunk_end {
                candidates_inspected += 1;
                let Some(record) = packed_record_at(&bytes, index) else {
                    continue;
                };
                if !packed_record_matches_query(record, query) {
                    continue;
                }
                accept_record(record);
            }
            chunk_start = chunk_end;
        }
    }
    drop(accept_record);

    let mut candidate_segments = Vec::<NativeCandidateSegment>::new();
    let mut sequence_dot_points = Vec::<MapPoint>::new();
    for (group_key, candidates) in grouped_line_candidates {
        let (mut line_segments, mut dot_segments) =
            split_group_by_consecutive_sequence(&group_key, candidates);
        candidate_segments.append(&mut line_segments);
        if cleanup.show_dots {
            sequence_dot_points.append(&mut dot_segments);
        }
    }

    let accepted_line_points = candidate_segments
        .iter()
        .map(|segment| segment.candidates.len())
        .sum::<usize>();
    let mut processed_segments = Vec::<NativeCandidateSegment>::new();
    let mut segment_dot_points = Vec::<MapPoint>::new();
    let mut filtered_jump_points = 0_usize;
    let mut line_speed_breaks = 0_usize;
    let mut line_distance_breaks = 0_usize;
    for segment in candidate_segments {
        let group_key = segment.group_key;
        let (jump_filtered, removed) = if cleanup.enabled && cleanup.remove_isolated_jumps {
            remove_isolated_jump_candidates(&segment.candidates, cleanup.break_speed_kmh)
        } else {
            (segment.candidates, 0)
        };
        filtered_jump_points += removed;
        let (distance_segments, distance_breaks) = split_candidates_by_max_segment_distance(
            &jump_filtered,
            cleanup.max_segment_distance_km,
        );
        line_distance_breaks += distance_breaks;
        for distance_segment in distance_segments {
            let (split_segments, breaks) =
                split_candidates_by_speed(&distance_segment, cleanup.break_speed_kmh);
            line_speed_breaks += breaks;
            for candidates in split_segments {
                if candidates.len() >= 2 {
                    processed_segments.push(NativeCandidateSegment {
                        group_key: group_key.clone(),
                        candidates,
                    });
                } else if cleanup.show_dots {
                    if let Some(candidate) = candidates.first() {
                        segment_dot_points.push(map_point_from_candidate(candidate));
                    }
                }
            }
        }
    }

    let polyline =
        polyline_from_candidate_segments(&processed_segments, requested_tolerance_px, max_points);
    let source_line_points = matched_records;
    let filtered_jump_points_total = filtered_jump_points;
    let filtered_line_points = filtered_quality_points + filtered_jump_points_total;
    let line_segments = polyline
        .segments
        .as_ref()
        .map(|segments| segments.len())
        .unwrap_or(0);
    let rendered_line_points = polyline.simplified_point_count;
    if cleanup.show_dots {
        dot_points.extend(sequence_dot_points);
        dot_points.extend(segment_dot_points);
    } else {
        dot_points.clear();
    }
    let limit_reached_by_dots = dot_points.len() > max_points;
    if limit_reached_by_dots {
        dot_points.truncate(max_points);
    }
    let rendered_line_dots = dot_points.len();
    Ok((
        MapPointPage {
            points: dot_points,
            polyline: Some(polyline),
            limit_reached: Some(limit_reached_by_dots),
            result_metrics: None,
        },
        pages_read,
        disk_read_bytes,
        candidates_inspected,
        matched_records,
        source_line_points,
        accepted_line_points,
        filtered_line_points,
        filtered_quality_points,
        filtered_jump_points_total,
        line_speed_breaks,
        line_distance_breaks,
        line_segments,
        rendered_line_points,
        rendered_line_dots,
        requested_tolerance_px,
    ))
}

fn search_file_catalog_index(
    app: &AppHandle,
    query: &CatalogQuery,
) -> AppResult<(Vec<MediaItem>, usize, usize, usize)> {
    let limit = query.limit.unwrap_or(500).clamp(1, 10_000) as usize;
    let offset = query.offset.unwrap_or(0).max(0) as usize;
    let mut candidate_limit = offset.saturating_add(limit);

    loop {
        let (asset_ids, scan_pages, scan_bytes, scan_inspected, scan_limit_reached) =
            scan_packed_asset_ids(app, query, candidate_limit)?;
        if asset_ids.is_empty() {
            return Ok((Vec::new(), scan_pages, scan_bytes, scan_inspected));
        }

        let (asset_rows, asset_metrics) = read_current_native_assets_by_asset_ids(app, &asset_ids)?;
        let pages_read = scan_pages + asset_metrics.disk_read_count;
        let disk_read_bytes = scan_bytes + asset_metrics.disk_read_bytes;
        let matched = asset_rows
            .into_iter()
            .filter(|row| item_matches_catalog_query(&row.item, query))
            .map(|row| row.item)
            .collect::<Vec<_>>();
        if matched.len() >= offset.saturating_add(limit) || !scan_limit_reached {
            let rows = matched.into_iter().skip(offset).take(limit).collect();
            return Ok((rows, pages_read, disk_read_bytes, scan_inspected));
        }
        let next_candidate_limit = candidate_limit
            .saturating_mul(2)
            .max(candidate_limit.saturating_add(1));
        if next_candidate_limit <= candidate_limit {
            let rows = matched.into_iter().skip(offset).take(limit).collect();
            return Ok((rows, pages_read, disk_read_bytes, scan_inspected));
        }
        candidate_limit = next_candidate_limit;
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
            .unwrap_or_else(|| "segmented-ball-tree".to_string());
        let engine_id = match engine_id.as_str() {
            "brute-force" | "segmented-ball-tree" => engine_id,
            _ => "segmented-ball-tree".to_string(),
        };
        if engine_id == "segmented-ball-tree" {
            require_search_index_current(&app, "segmented-ball-tree", "Segmented ball tree")?;
        }
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
        let results = search_geo_index(app.clone(), engine_id.clone(), query)?;
        let geo_stats = get_geo_index_stats(app.clone(), engine_id.clone())?;
        let distance_limit_reached = (offset + limit) < geo_stats.point_count as i64;
        let ids = results
            .iter()
            .map(|result| result.media_id.clone())
            .collect::<Vec<_>>();
        let items = get_media_by_ids(app, ids)?;
        let (engine_label, exact, persistent) = match engine_id.as_str() {
            "brute-force" => ("Brute force oracle", true, false),
            "segmented-ball-tree" => ("Segmented ball tree", true, true),
            _ => ("Segmented ball tree", true, true),
        };
        let rows = enriched_distance_rows(items, results);
        let result_metrics = with_query_metrics(
            search_stats_from_geo(geo_stats, engine_label, exact, persistent),
            &spec,
            "native",
            started_at.elapsed().as_secs_f64() * 1000.0,
            rows.len(),
            limit,
            offset,
            distance_limit_reached,
        );

        return Ok(SearchPage {
            items: rows,
            result_metrics,
            engine_id,
            engine_label: engine_label.to_string(),
            limit_reached: Some(distance_limit_reached),
        });
    }

    let (engine_id, engine_label) = file_search_engine(&spec)?;
    let mut index_stats = require_search_index_current(&app, engine_id, engine_label)?;
    let query = search_spec_to_catalog_query(&spec, limit.saturating_add(1));
    let (rows, pages_read, disk_read_bytes, candidates_inspected) =
        search_file_catalog_index(&app, &query)?;
    index_stats.pages_read = pages_read as i64;
    index_stats.disk_read_bytes = Some(disk_read_bytes);
    index_stats.candidates_inspected = candidates_inspected as i64;
    let limit_reached = rows.len() > limit as usize;
    let items = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let rows_returned = items.len();

    Ok(SearchPage {
        items: media_items_to_search_rows(items),
        result_metrics: with_query_metrics(
            index_stats,
            &spec,
            "native",
            started_at.elapsed().as_secs_f64() * 1000.0,
            rows_returned,
            limit,
            offset,
            limit_reached,
        ),
        engine_id: engine_id.to_string(),
        engine_label: engine_label.to_string(),
        limit_reached: Some(limit_reached),
    })
}

#[tauri::command]
fn search_map_points(app: AppHandle, spec: SearchSpec) -> AppResult<MapPointPage> {
    let started_at = Instant::now();
    let (engine_id, engine_label) = file_search_engine(&spec)?;
    let mut index_stats = require_search_index_current(&app, engine_id, engine_label)?;
    let limit = spec.limit.unwrap_or(500).clamp(1, MAX_RENDERED_MAP_BUBBLES) as usize;
    let offset = spec.offset.unwrap_or(0).max(0) as usize;
    let query = search_spec_to_catalog_query(&spec, limit.saturating_add(1) as i64);
    if spec.map_mode.as_deref() == Some("polyline") {
        let (
            mut page,
            pages_read,
            disk_read_bytes,
            candidates_inspected,
            matched_records,
            source_line_points,
            accepted_line_points,
            filtered_line_points,
            filtered_quality_points,
            filtered_jump_points,
            line_speed_breaks,
            line_distance_breaks,
            line_segments,
            rendered_line_points,
            rendered_line_dots,
            simplification_tolerance_px,
        ) = scan_packed_map_polyline(
            &app,
            &query,
            spec.map_aggregation.as_ref(),
            spec.map_polyline.as_ref(),
        )?;
        index_stats.pages_read = pages_read as i64;
        index_stats.disk_read_bytes = Some(disk_read_bytes);
        index_stats.candidates_inspected = candidates_inspected as i64;
        let map_limit_reached = page.limit_reached.unwrap_or(false);
        let mut result_metrics = with_query_metrics(
            index_stats,
            &spec,
            "native",
            started_at.elapsed().as_secs_f64() * 1000.0,
            rendered_line_points + rendered_line_dots,
            spec.map_polyline
                .as_ref()
                .map(|options| options.max_points as i64)
                .unwrap_or(limit as i64),
            offset as i64,
            map_limit_reached,
        );
        result_metrics.matched_records = Some(matched_records);
        result_metrics.source_line_points = Some(source_line_points);
        result_metrics.accepted_line_points = Some(accepted_line_points);
        result_metrics.filtered_line_points = Some(filtered_line_points);
        result_metrics.filtered_quality_points = Some(filtered_quality_points);
        result_metrics.filtered_jump_points = Some(filtered_jump_points);
        result_metrics.line_speed_breaks = Some(line_speed_breaks);
        result_metrics.line_distance_breaks = Some(line_distance_breaks);
        result_metrics.line_segments = Some(line_segments);
        result_metrics.rendered_line_points = Some(rendered_line_points);
        result_metrics.rendered_line_dots = Some(rendered_line_dots);
        result_metrics.simplification_tolerance_px = Some(simplification_tolerance_px);
        page.result_metrics = Some(result_metrics);
        return Ok(page);
    }

    let (
        mut page,
        pages_read,
        disk_read_bytes,
        candidates_inspected,
        matched_records,
        rendered_bubbles,
        largest_bubble_count,
        aggregation_zoom,
        aggregation_cell_size_px,
    ) = scan_packed_map_points(&app, &query, spec.map_aggregation.as_ref(), limit, offset)?;
    index_stats.pages_read = pages_read as i64;
    index_stats.disk_read_bytes = Some(disk_read_bytes);
    index_stats.candidates_inspected = candidates_inspected as i64;
    let mut result_metrics = with_query_metrics(
        index_stats,
        &spec,
        "native",
        started_at.elapsed().as_secs_f64() * 1000.0,
        page.points.len(),
        limit as i64,
        offset as i64,
        page.limit_reached.unwrap_or(false),
    );
    result_metrics.matched_records = Some(matched_records);
    result_metrics.rendered_bubbles = Some(rendered_bubbles);
    result_metrics.largest_bubble_count = Some(largest_bubble_count);
    result_metrics.aggregation_zoom = Some(aggregation_zoom);
    result_metrics.aggregation_cell_size_px = Some(aggregation_cell_size_px);
    page.result_metrics = Some(result_metrics);
    Ok(page)
}

#[tauri::command]
fn get_media_by_ids(app: AppHandle, ids: Vec<String>) -> AppResult<Vec<MediaItem>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let (items, _) = read_current_native_assets_by_media_ids(&app, &ids)?;
    Ok(items)
}

#[tauri::command]
fn get_geo_points(app: AppHandle, range: TimeRange) -> AppResult<Vec<GeoIndexPoint>> {
    let mut points = Vec::new();
    for item in active_media_items(&app)? {
        let Some(lat) = item.latitude else {
            continue;
        };
        let Some(lon) = item.longitude else {
            continue;
        };
        if let Some(start_time) = range.start_time {
            if item
                .timestamp
                .is_none_or(|timestamp| timestamp < start_time)
            {
                continue;
            }
        }
        if let Some(end_time) = range.end_time {
            if item.timestamp.is_none_or(|timestamp| timestamp > end_time) {
                continue;
            }
        }
        points.push(GeoIndexPoint {
            media_id: item.id,
            kind: Some(item.kind),
            lat,
            lon,
            timestamp: item.timestamp,
        });
    }
    points.sort_by(|a, b| a.media_id.cmp(&b.media_id));
    Ok(points)
}

fn for_each_geo_point_batch(
    app: &AppHandle,
    batch_size: usize,
    mut on_batch: impl FnMut(Vec<GeoIndexPoint>, usize) -> AppResult<()>,
) -> AppResult<usize> {
    let mut processed = 0_usize;
    let points = get_geo_points(
        app.clone(),
        TimeRange {
            start_time: None,
            end_time: None,
        },
    )?;
    for batch in points.chunks(batch_size.max(1)) {
        processed += batch.len();
        on_batch(batch.to_vec(), processed)?;
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
    let total_indexes = 1_usize;

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
    if index_id == "file-time-geo" {
        return build_file_catalog_indexes(&app, &window, &index_id, started);
    }
    let total_indexes = 1_usize;
    let selected_index_id = match index_id.as_str() {
        "brute-force" => "brute-force",
        "segmented-ball-tree" => "segmented-ball-tree",
        _ => "segmented-ball-tree",
    };
    let selected_index_label = match selected_index_id {
        "brute-force" => "Brute force oracle",
        "segmented-ball-tree" => "Segmented ball tree",
        _ => "Segmented ball tree",
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

    let epoch = if selected_index_id == "segmented-ball-tree" {
        Some(catalog_epoch(&app)?)
    } else {
        None
    };
    if let Some(epoch) = epoch {
        let should_restore = !force_rebuild.unwrap_or(false);
        let restored = match selected_index_id {
            "segmented-ball-tree" => should_restore
                .then(|| load_persisted_segmented_ball_tree_index(&app, epoch))
                .transpose()?
                .flatten(),
            _ => None,
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
                engine_count: 4,
            });
        }
    }

    if let Some(epoch) = epoch {
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
                engine_count: 4,
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
        }
    }

    if let Some(epoch) = epoch {
        let _ = match selected_index_id {
            "segmented-ball-tree" => save_persisted_segmented_ball_tree_index(&app, epoch),
            _ => Ok(()),
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
        engine_count: 4,
    })
}

fn build_file_catalog_indexes(
    app: &AppHandle,
    window: &Window,
    index_id: &str,
    started: Instant,
) -> AppResult<SearchIndexBuildSummary> {
    let label = "Catalog packed indexes";
    emit_geo_index_progress(
        window,
        GeoIndexBuildProgress {
            phase: "building".to_string(),
            point_count: 0,
            built_indexes: 0,
            total_indexes: 1,
            current_index_id: Some(index_id.to_string()),
            current_index_label: Some(label.to_string()),
            current_index_processed_points: None,
            current_index_total_points: None,
        },
    );
    let mut manifest = load_file_catalog_manifest(app)?;
    if manifest.materialized_version != manifest.catalog_version {
        emit_geo_index_progress(
            window,
            GeoIndexBuildProgress {
                phase: "building".to_string(),
                point_count: manifest.asset_count.max(manifest.occurrence_count),
                built_indexes: 0,
                total_indexes: 1,
                current_index_id: Some(index_id.to_string()),
                current_index_label: Some(format!("{label}: materializing catalog")),
                current_index_processed_points: Some(0),
                current_index_total_points: Some(
                    manifest.asset_count.max(manifest.occurrence_count),
                ),
            },
        );
        let mut progress_callback = |processed: usize, total: usize, phase_label: &str| {
            emit_geo_index_progress(
                window,
                GeoIndexBuildProgress {
                    phase: "building".to_string(),
                    point_count: total,
                    built_indexes: 0,
                    total_indexes: 1,
                    current_index_id: Some(index_id.to_string()),
                    current_index_label: Some(format!(
                        "{label}: materializing catalog: {phase_label}"
                    )),
                    current_index_processed_points: Some(processed),
                    current_index_total_points: Some(total),
                },
            );
        };
        materialize_file_catalog_with_progress(app, &mut manifest, Some(&mut progress_callback))?;
    }
    manifest.index_applied_version = -1;
    manifest.index_job = Some(FileCatalogIndexJob {
        status: "indexing".to_string(),
        pending_since: manifest
            .index_job
            .as_ref()
            .and_then(|job| job.pending_since)
            .or(Some(current_timestamp_millis())),
        started_at: Some(current_timestamp_millis()),
        finished_at: None,
        failed_message: None,
    });
    save_file_catalog_manifest(app, &manifest)?;
    write_file_catalog_indexes(app, &manifest)?;
    manifest.index_applied_version = manifest.catalog_version;
    manifest.index_job = Some(FileCatalogIndexJob {
        status: "current".to_string(),
        pending_since: manifest
            .index_job
            .as_ref()
            .and_then(|job| job.pending_since),
        started_at: manifest.index_job.as_ref().and_then(|job| job.started_at),
        finished_at: Some(current_timestamp_millis()),
        failed_message: None,
    });
    save_file_catalog_manifest(app, &manifest)?;
    emit_geo_index_progress(
        window,
        GeoIndexBuildProgress {
            phase: "ready".to_string(),
            point_count: manifest.asset_count,
            built_indexes: 1,
            total_indexes: 1,
            current_index_id: Some(index_id.to_string()),
            current_index_label: Some(label.to_string()),
            current_index_processed_points: Some(manifest.asset_count),
            current_index_total_points: Some(manifest.asset_count),
        },
    );
    Ok(SearchIndexBuildSummary {
        point_count: manifest.asset_count,
        build_time_ms: started.elapsed().as_secs_f64() * 1000.0,
        engine_count: 1,
    })
}

#[tauri::command]
fn search_geo_index(
    app: AppHandle,
    index_id: String,
    query: GeoSearchQuery,
) -> AppResult<Vec<GeoSearchResult>> {
    if index_id == "segmented-ball-tree" {
        require_search_index_current(&app, "segmented-ball-tree", "Segmented ball tree")?;
    }
    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let results = match index_id.as_str() {
        "segmented-ball-tree" => registry.segmented_ball_tree.search(&query),
        "brute-force" => registry.brute_force.search(&query),
        _ => registry.segmented_ball_tree.search(&query),
    };
    Ok(results)
}

#[tauri::command]
fn get_geo_index_stats(_app: AppHandle, index_id: String) -> AppResult<GeoIndexStats> {
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(match index_id.as_str() {
        "segmented-ball-tree" => registry.segmented_ball_tree.last_stats.clone(),
        "brute-force" => registry.brute_force.last_stats.clone(),
        _ => registry.segmented_ball_tree.last_stats.clone(),
    })
}

#[tauri::command]
fn get_search_index_stats(app: AppHandle) -> AppResult<Vec<SearchIndexStats>> {
    let registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let brute_force_stats = search_stats_from_geo(
        registry.brute_force.last_stats.clone(),
        "Brute force oracle",
        true,
        false,
    );
    drop(registry);
    Ok(vec![
        file_catalog_index_status_stats(&app, "file-time-geo", "Time-first packed index")?,
        brute_force_stats,
        segmented_ball_tree_status_stats(&app)?,
    ])
}

fn file_catalog_index_status_stats(
    app: &AppHandle,
    engine_id: &str,
    engine_label: &str,
) -> AppResult<SearchIndexStats> {
    let manifest = load_file_catalog_manifest(app)?;
    let required_file = (FILE_CATALOG_TIME_GEO_INDEX, INDEX_KIND_TIME_GEO);
    let indexes_dir = catalog_indexes_dir(app)?;
    let path = indexes_dir.join(required_file.0);
    let header = packed_index_header(&path, required_file.1);
    let existing_file = path.is_file();
    let index_catalog_version = header.as_ref().map(|header| header.catalog_version);
    let index_size_bytes = header.as_ref().map(|header| header.index_size_bytes);
    let is_current = header.is_some()
        && manifest.materialized_version == manifest.catalog_version
        && manifest.index_applied_version == manifest.catalog_version
        && index_catalog_version == Some(manifest.catalog_version);
    let file_exists = existing_file || header.is_some();
    let mut stats = empty_search_index_stats(engine_id, engine_label);
    stats.point_count = manifest.asset_count;
    stats.index_size_bytes = index_size_bytes;
    stats.index_storage = Some("disk".to_string());
    stats.index_status = Some(
        if is_current {
            "current"
        } else if manifest.index_job.as_ref().map(|job| job.status.as_str()) == Some("indexing") {
            "indexing"
        } else if manifest.index_job.as_ref().map(|job| job.status.as_str()) == Some("pending") {
            "pending"
        } else if manifest.index_job.as_ref().map(|job| job.status.as_str()) == Some("failed") {
            "failed"
        } else if file_exists {
            "stale"
        } else {
            "missing"
        }
        .to_string(),
    );
    stats.catalog_version = Some(manifest.catalog_version);
    stats.index_catalog_version = index_catalog_version;
    Ok(stats)
}

fn require_search_index_current(
    app: &AppHandle,
    engine_id: &str,
    engine_label: &str,
) -> AppResult<SearchIndexStats> {
    let stats = match engine_id {
        "file-time-geo" => file_catalog_index_status_stats(app, engine_id, engine_label)?,
        "segmented-ball-tree" => segmented_ball_tree_status_stats(app)?,
        _ => empty_search_index_stats(engine_id, engine_label),
    };
    if stats.index_status.as_deref() != Some("current") {
        return Err(format!(
            "{} index is {}. Update the index before querying.",
            stats.engine_label.as_deref().unwrap_or(engine_label),
            stats.index_status.as_deref().unwrap_or("not ready")
        ));
    }
    Ok(stats)
}
fn segmented_ball_tree_status_stats(app: &AppHandle) -> AppResult<SearchIndexStats> {
    let catalog_version = catalog_epoch(app)?;
    let dir = disk_segmented_index_dir(app, "segmented-ball-tree")?;
    let manifest_path = dir.join("manifest.json");
    let manifest = if manifest_path.exists() {
        fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|content| serde_json::from_str::<NativeDiskSegmentedManifest>(&content).ok())
    } else {
        None
    };

    if let Some(manifest) = manifest {
        let index_catalog_version = manifest.catalog_epoch;
        let index_size_bytes = manifest
            .segments
            .iter()
            .map(|segment| segment.byte_len)
            .sum::<usize>();
        let is_current =
            validate_disk_segmented_manifest(&manifest, "segmented-ball-tree", catalog_version)
                .is_ok()
                && manifest
                    .segments
                    .iter()
                    .all(|segment| segment_file_path(&dir, &segment.id).exists());
        if is_current {
            let _ = load_persisted_segmented_ball_tree_index(app, catalog_version)?;
            let registry = geo_index_registry()
                .lock()
                .map_err(|error| error.to_string())?;
            let mut stats = search_stats_from_geo(
                registry.segmented_ball_tree.last_stats.clone(),
                "Segmented ball tree",
                true,
                true,
            );
            stats.index_status = Some("current".to_string());
            stats.catalog_version = Some(catalog_version);
            stats.index_catalog_version = Some(index_catalog_version);
            return Ok(stats);
        }

        {
            let mut registry = geo_index_registry()
                .lock()
                .map_err(|error| error.to_string())?;
            registry.segmented_ball_tree = NativeSegmentedBallTreeIndex::default();
        }
        let mut stats = empty_search_index_stats("segmented-ball-tree", "Segmented ball tree");
        stats.point_count = manifest.point_count;
        stats.index_size_bytes = Some(index_size_bytes);
        stats.index_storage = Some("disk".to_string());
        stats.segment_count = Some(manifest.segment_count);
        stats.index_status = Some("stale".to_string());
        stats.catalog_version = Some(catalog_version);
        stats.index_catalog_version = Some(index_catalog_version);
        return Ok(stats);
    }

    {
        let mut registry = geo_index_registry()
            .lock()
            .map_err(|error| error.to_string())?;
        registry.segmented_ball_tree = NativeSegmentedBallTreeIndex::default();
    }
    let mut stats = empty_search_index_stats("segmented-ball-tree", "Segmented ball tree");
    stats.index_storage = Some("disk".to_string());
    stats.index_status = Some("missing".to_string());
    stats.catalog_version = Some(catalog_version);
    Ok(stats)
}

#[tauri::command]
fn validate_geo_index(
    app: AppHandle,
    index_id: String,
    query: GeoSearchQuery,
) -> AppResult<ValidationReport> {
    if index_id == "brute-force" {
        return Ok(ValidationReport {
            checked: true,
            equal: true,
            compared_with: "brute-force".to_string(),
            message: "Brute force is the comparison baseline.".to_string(),
        });
    }
    if index_id == "segmented-ball-tree" {
        require_search_index_current(&app, "segmented-ball-tree", "Segmented ball tree")?;
    }

    let mut registry = geo_index_registry()
        .lock()
        .map_err(|error| error.to_string())?;
    let actual = match index_id.as_str() {
        "segmented-ball-tree" => registry.segmented_ball_tree.search(&query),
        _ => registry.segmented_ball_tree.search(&query),
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
    let manifest = load_file_catalog_manifest(&app)?;
    let mut sources = manifest
        .sources
        .into_values()
        .filter(|source| source.active)
        .map(|source| MediaSource {
            id: source.id,
            label: source.label,
            root_path: source.root_path,
        })
        .collect::<Vec<_>>();
    sources.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
    Ok(sources)
}

#[tauri::command]
fn remove_sources(app: AppHandle, source_ids: Vec<String>) -> AppResult<()> {
    if source_ids.is_empty() {
        return Ok(());
    }
    let removing = source_ids.into_iter().collect::<HashSet<_>>();
    let mut manifest = load_file_catalog_manifest(&app)?;
    let mut changed = false;
    for source in manifest.sources.values_mut() {
        if removing.contains(&source.id) && source.active {
            source.active = false;
            changed = true;
        }
    }
    for chunk in manifest.chunks.iter_mut() {
        if removing.contains(&chunk.source_id) && chunk.active {
            chunk.active = false;
            changed = true;
        }
    }
    if changed {
        bump_catalog_epoch(&app, &mut manifest)?;
        materialize_file_catalog(&app, &mut manifest)?;
    } else {
        save_file_catalog_manifest(&app, &manifest)?;
    }
    Ok(())
}

#[tauri::command]
fn count_media(app: AppHandle) -> AppResult<i64> {
    Ok(active_media_items(&app)?.len() as i64)
}

#[tauri::command]
fn clear_catalog(app: AppHandle) -> AppResult<()> {
    let dir = catalog_dir(&app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    ensure_file_catalog_dirs(&app)?;
    save_file_catalog_manifest(&app, &empty_file_catalog_manifest())?;
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

struct NativeImportSession {
    source_id: String,
    generation: i64,
}

fn flush_media_batch(
    app: &AppHandle,
    session: &NativeImportSession,
    batch: &mut Vec<MediaItem>,
) -> AppResult<usize> {
    if batch.is_empty() {
        return Ok(0);
    }
    let written = append_media_items(app, &session.source_id, session.generation, batch)?;
    batch.clear();
    Ok(written)
}

fn flush_and_commit_geo_import_if_requested(
    app: &AppHandle,
    session: &NativeImportSession,
    batch: &mut Vec<MediaItem>,
) -> AppResult<()> {
    if !take_import_commit_requested() {
        return Ok(());
    }
    flush_media_batch(app, session, batch)?;
    let mut manifest = load_file_catalog_manifest(app)?;
    materialize_file_catalog(app, &mut manifest)?;
    Ok(())
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
    app: &AppHandle,
    path: &Path,
    source: &MediaSource,
    session: &NativeImportSession,
    absolute_path: &str,
    total_bytes: i64,
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
                flush_media_batch(app, session, &mut batch)?;
                flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
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
        flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
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
    flush_media_batch(app, session, &mut batch)?;
    flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
    Ok((accepted_media, parser.skipped_points, cancelled))
}

fn import_google_timeline_json(
    app: &AppHandle,
    path: &Path,
    source: &MediaSource,
    session: &NativeImportSession,
    total_bytes: i64,
    window: &Window,
) -> AppResult<(i64, i64, bool)> {
    let source_label = source.label.clone();
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let (items, skipped_points) = parse_google_timeline_location_items(&text)?;
    let mut batch = Vec::<MediaItem>::new();
    let mut accepted_media = 0_i64;
    let mut cancelled = false;

    for item in items.iter() {
        if import_cancelled() {
            cancelled = true;
            break;
        }
        batch.push(media_item_from_parsed_geo_item(
            source,
            "application/json",
            item,
        ));
        accepted_media += 1;
        if batch.len() >= IMPORT_BATCH_SIZE {
            emit_progress(
                window,
                import_progress_bytes(
                    "scanning",
                    &source_label,
                    accepted_media,
                    skipped_points,
                    Some(source_label.clone()),
                    total_bytes,
                    total_bytes,
                ),
            );
            flush_media_batch(app, session, &mut batch)?;
            flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
        }
    }

    emit_progress(
        window,
        import_progress_bytes(
            "storing",
            &source_label,
            accepted_media,
            skipped_points,
            Some(source_label.clone()),
            total_bytes,
            total_bytes,
        ),
    );
    flush_media_batch(app, session, &mut batch)?;
    flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
    Ok((accepted_media, skipped_points, cancelled))
}

fn import_gpx_streaming(
    app: &AppHandle,
    path: &Path,
    source: &MediaSource,
    session: &NativeImportSession,
    absolute_path: &str,
    total_bytes: i64,
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
                    flush_media_batch(app, session, &mut batch)?;
                    flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
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
                flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
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
                flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
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
    flush_media_batch(app, session, &mut batch)?;
    flush_and_commit_geo_import_if_requested(app, session, &mut batch)?;
    Ok((accepted_media, skipped_files, cancelled))
}

#[tauri::command]
fn import_folder(app: AppHandle, window: Window) -> AppResult<ImportSummary> {
    let Some(root) = rfd::FileDialog::new().pick_folder() else {
        return Err("Import cancelled".to_string());
    };
    reset_import_cancel();
    let root = root.canonicalize().unwrap_or(root);
    import_folder_from_root(app, window, root)
}

fn import_folder_from_root(
    app: AppHandle,
    window: Window,
    root: PathBuf,
) -> AppResult<ImportSummary> {
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

    let generation = prepare_import_source(&app, &source)?;
    let session = NativeImportSession {
        source_id: source.id.clone(),
        generation,
    };

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
                        flush_media_batch(&app, &session, &mut batch)?;
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
    flush_media_batch(&app, &session, &mut batch)?;
    if !cancelled {
        let mut manifest = load_file_catalog_manifest(&app)?;
        materialize_file_catalog(&app, &mut manifest)?;
    }

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
fn rescan_folders(app: AppHandle, window: Window) -> AppResult<ImportSummary> {
    reset_import_cancel();
    let manifest = load_file_catalog_manifest(&app)?;
    let source = MediaSource {
        id: "rescan-folders".to_string(),
        label: "Previously scanned folders".to_string(),
        root_path: None,
    };
    let mut summary = ImportSummary {
        source,
        source_label: "Previously scanned folders".to_string(),
        scanned_files: 0,
        total_files: 0,
        accepted_media: 0,
        skipped_files: 0,
        errors: Vec::new(),
        cancelled: None,
    };
    let mut roots = manifest
        .sources
        .values()
        .filter(|source| source.active)
        .filter_map(|source| source.root_path.as_ref())
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();

    for root in roots {
        if import_cancelled() {
            summary.cancelled = Some(true);
            break;
        }
        if !root.exists() {
            summary.errors.push(format!(
                "{}: folder is not available",
                root.to_string_lossy()
            ));
            continue;
        }
        match import_folder_from_root(app.clone(), window.clone(), root.clone()) {
            Ok(source_summary) => {
                summary.scanned_files += source_summary.scanned_files;
                summary.total_files += source_summary.total_files;
                summary.accepted_media += source_summary.accepted_media;
                summary.skipped_files += source_summary.skipped_files;
                summary.errors.extend(source_summary.errors);
                if source_summary.cancelled.unwrap_or(false) {
                    summary.cancelled = Some(true);
                    break;
                }
            }
            Err(error) => {
                summary
                    .errors
                    .push(format!("{}: {error}", root.to_string_lossy()));
            }
        }
    }

    Ok(summary)
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
    let generation = prepare_import_source(&app, &source)?;
    let session = NativeImportSession {
        source_id: source.id.clone(),
        generation,
    };
    let (accepted_media, skipped_files, cancelled) = if import_cancelled() {
        (0, 0, true)
    } else {
        let result = match format {
            GeoFileFormat::GoogleTakeoutJson => import_google_takeout_streaming(
                &app,
                &path,
                &source,
                &session,
                &absolute_path,
                total_bytes,
                &window,
            ),
            GeoFileFormat::GoogleTimelineJson => {
                import_google_timeline_json(&app, &path, &source, &session, total_bytes, &window)
            }
            GeoFileFormat::Gpx => import_gpx_streaming(
                &app,
                &path,
                &source,
                &session,
                &absolute_path,
                total_bytes,
                &window,
            ),
        };
        match result {
            Ok(summary) => {
                if summary.0 > 0 {
                    let mut manifest = load_file_catalog_manifest(&app)?;
                    materialize_file_catalog(&app, &mut manifest)?;
                }
                summary
            }
            Err(error) => return Err(error),
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
            search_map_points,
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
            rescan_folders,
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
            end_timestamp: None,
            latitude: Some(47.0),
            longitude: Some(8.0),
            thumbnail_key: Some(format!("thumbs/{content_hash}.webp")),
            source_dataset: None,
            source_type: None,
            accuracy_meters: None,
            altitude_meters: None,
            vertical_accuracy_meters: None,
            velocity_meters_per_second: None,
            heading_degrees: None,
            group_id: None,
            sequence: None,
            metadata: None,
            locations: vec![MediaLocation {
                id: location_id,
                source_id: source_id.to_string(),
                source_label: source_id.to_string(),
                root_path: Some("/tmp/source".to_string()),
                relative_path: Some(path.to_string()),
                absolute_path: None,
                point_index: None,
                source_dataset: None,
                source_type: None,
                group_id: None,
                sequence: None,
                timestamp: None,
                end_timestamp: None,
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

    #[test]
    fn native_asset_store_reads_selected_records_by_asset_and_media_id() {
        let dir = test_disk_dir("asset-store");
        let items = vec![
            test_item("hash-a", "source-a", "a.jpg"),
            test_item("hash-b", "source-a", "b.jpg"),
            test_item("hash-c", "source-b", "c.jpg"),
        ];
        write_native_asset_store(&dir, 42, &items).unwrap();

        let table = NativeAssetTable {
            assets_dir: dir.clone(),
            record_index_path: dir.join(ASSET_RECORD_INDEX_FILE),
            header: read_native_binary_header(
                &dir.join(ASSET_RECORD_INDEX_FILE),
                ASSET_TABLE_MAGIC,
            )
            .unwrap(),
        };
        let all = read_all_native_assets_from_table(&table).unwrap();
        assert_eq!(
            all.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            vec!["hash-a", "hash-b", "hash-c"]
        );

        let (selected, metrics) =
            read_native_assets_by_asset_ids_from_table(&table, &[2, 0, 2, 99]).unwrap();
        assert!(metrics.disk_read_count > 0);
        assert_eq!(
            selected
                .iter()
                .map(|row| row.item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["hash-c", "hash-a", "hash-c"]
        );

        let id_map = NativeAssetIdMap {
            path: dir.join(ASSET_ID_MAP_FILE),
            header: read_native_binary_header(&dir.join(ASSET_ID_MAP_FILE), ASSET_ID_MAP_MAGIC)
                .unwrap(),
        };
        let (asset_ids, _) = find_native_asset_ids_by_media_ids(
            &id_map,
            &[
                "hash-b".to_string(),
                "missing".to_string(),
                "hash-a".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(asset_ids, vec![1, 0]);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_packed_time_geo_index_writes_and_scans_100k_no_match_kind() {
        let dir = test_disk_dir("packed-time-geo-large");
        let path = dir.join(FILE_CATALOG_TIME_GEO_INDEX);
        let mut manifest = empty_file_catalog_manifest();
        manifest.catalog_version = 42;
        manifest.asset_count = 100_000;
        manifest.index_applied_version = 42;
        let mut records = (0..100_000)
            .map(|index| NativePackedIndexRecord {
                timestamp_sec: index as u32,
                lat_e7: lat_e7(-80.0 + (index % 16_000) as f64 / 100.0),
                lon_e7: lon_e7(-170.0 + (index % 34_000) as f64 / 100.0),
                asset_id: index,
                kind_flags: KIND_CODE_GEO_POINT | KIND_FLAG_HAS_GEO,
                source_code: LINE_SOURCE_UNKNOWN,
                quality_flags: 0,
                accuracy_meters: f32::NAN,
                velocity_meters_per_second: f32::NAN,
                heading_degrees: f32::NAN,
                group_hash: 0,
                sequence: -1,
            })
            .collect::<Vec<_>>();

        write_packed_index_file(&path, INDEX_KIND_TIME_GEO, &manifest, &mut records).unwrap();
        let (header, bytes) = read_packed_index_bytes(&path, INDEX_KIND_TIME_GEO).unwrap();
        let query = CatalogQuery {
            kind: Some("image".to_string()),
            source_id: None,
            has_geo: None,
            geo_bounds: None,
            sort: "timestamp_desc".to_string(),
            limit: Some(500),
            offset: Some(0),
            start_time: None,
            end_time: None,
        };
        let mut inspected = 0_usize;
        let mut matched = 0_usize;
        for index in (0..header.entry_count).rev() {
            inspected += 1;
            if let Some(record) = packed_record_at(&bytes, index) {
                if packed_record_matches_query(record, &query) {
                    matched += 1;
                }
            }
        }

        assert_eq!(header.entry_count, 100_000);
        assert_eq!(inspected, 100_000);
        assert_eq!(matched, 0);
        let _ = fs::remove_dir_all(dir);
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
        assert_eq!(parsed.points[0].kind, "geo_point");
        assert_eq!(
            parsed.points[0].source_dataset.as_deref(),
            Some("google_records")
        );
        assert_eq!(parsed.points[0].source_type.as_deref(), Some("CELL"));
        assert_eq!(parsed.points[0].accuracy_meters, Some(540.0));
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
    fn parses_google_timeline_semantic_json_items() {
        let (items, skipped_points) = parse_google_timeline_location_items(
            r#"
            {
              "semanticSegments": [{
                "startTime": "2026-06-01T10:00:00.000+02:00",
                "endTime": "2026-06-01T11:00:00.000+02:00",
                "timelinePath": [{
                  "point": "48.1370673°, 11.5775995°",
                  "time": "2026-06-01T10:10:00.000+02:00"
                }],
                "visit": {
                  "hierarchyLevel": 0,
                  "probability": 0.9,
                  "topCandidate": {
                    "placeId": "place-1",
                    "semanticType": "UNKNOWN",
                    "probability": 0.8,
                    "placeLocation": { "latLng": "48.1370673°, 11.5775995°" }
                  }
                },
                "activity": {
                  "distanceMeters": 1234,
                  "start": { "latLng": "48.1370673°, 11.5775995°" },
                  "end": { "latLng": "48.2°, 11.6°" },
                  "topCandidate": { "type": "WALKING", "probability": 0.75 }
                }
              }],
              "rawSignals": [{
                "position": {
                  "latitudeE7": 482000000,
                  "longitudeE7": 116000000,
                  "accuracy": 12,
                  "altitude": 366,
                  "verticalAccuracy": 2,
                  "velocity": 3.5,
                  "heading": 80,
                  "source": "GPS",
                  "timestamp": "2026-06-01T12:00:00.000+02:00"
                }
              }, {
                "activityRecord": {
                  "timestamp": "2026-06-01T12:05:00.000+02:00",
                  "probableActivities": [{ "type": "STILL", "probability": 0.9 }]
                }
              }, {
                "wifiScan": { "devicesRecords": [{ "mac": 1 }] }
              }],
              "userLocationProfile": {
                "frequentPlaces": [{
                  "placeId": "home",
                  "label": "HOME",
                  "placeLocation": { "latLng": "48.3°, 11.7°" }
                }]
              }
            }
            "#,
        )
        .unwrap();

        assert_eq!(skipped_points, 0);
        assert_eq!(
            items
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "geo_point",
                "activity_sample",
                "geo_point",
                "timeline_visit",
                "timeline_activity",
                "frequent_place"
            ]
        );
        assert_eq!(items[0].source_type.as_deref(), Some("GPS"));
        assert_eq!(items[0].accuracy_meters, Some(12.0));
        assert_eq!(items[0].altitude_meters, Some(366.0));
        assert_eq!(items[0].vertical_accuracy_meters, Some(2.0));
        assert_eq!(items[0].velocity_meters_per_second, Some(3.5));
        assert_eq!(items[0].heading_degrees, Some(80.0));
        assert_eq!(items[2].source_type.as_deref(), Some("timeline_path"));
        assert_eq!(items[2].sequence, Some(0));
        assert_eq!(items[3].source_type.as_deref(), Some("visit"));
        assert_eq!(items[4].source_type.as_deref(), Some("activity"));
        assert_eq!(items[5].source_type.as_deref(), Some("frequent_place"));
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
                Path::new("timeline.json"),
                r#"{ "semanticSegments": [], "rawSignals": [] }"#
            )
            .unwrap(),
            GeoFileFormat::GoogleTimelineJson
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
    fn normalizes_one_asset_with_many_locations() {
        let first = test_item("same-hash", "source-a", "a/photo.jpg");
        let second = test_item("same-hash", "source-b", "b/photo-copy.jpg");
        let normalized = normalize_media_item(
            first.clone(),
            vec![first.locations[0].clone(), second.locations[0].clone()],
            Some("source-b"),
        );

        assert_eq!(normalized.content_hash, "same-hash");
        assert_eq!(normalized.locations.len(), 2);
        assert_eq!(normalized.source_id, "source-b");
        assert_eq!(normalized.relative_path, "b/photo-copy.jpg");
    }
}
