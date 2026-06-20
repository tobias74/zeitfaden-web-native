use chrono::NaiveDateTime;
use exif::{In, Reader, Tag, Value as ExifValue};
use image::ImageFormat;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Window};
use walkdir::WalkDir;

type AppResult<T> = Result<T, String>;

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
struct CatalogQuery {
    kind: Option<String>,
    source_id: Option<String>,
    has_geo: Option<bool>,
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
    lat: f64,
    lon: f64,
    captured_at: Option<i64>,
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
          UNIQUE(source_id, absolute_path),
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
    let exif = match Reader::new().read_from_container(&mut reader) {
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

fn upsert_media_tx(conn: &mut Connection, items: &[MediaItem]) -> AppResult<usize> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    {
        let mut asset_stmt = tx
            .prepare(
                "
                INSERT INTO media_assets (
                  content_hash, kind, mime_type, size_bytes, width, height, duration_ms,
                  captured_at, captured_at_source, latitude, longitude, geo_source,
                  thumbnail_key, deleted_at, last_seen_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
            )
            .map_err(|error| error.to_string())?;
        let mut location_stmt = tx
            .prepare(
                "
                INSERT INTO media_locations (
                  id, content_hash, source_id, relative_path, absolute_path, display_name,
                  deleted_at, last_seen_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(id) DO UPDATE SET
                  content_hash = excluded.content_hash,
                  source_id = excluded.source_id,
                  relative_path = excluded.relative_path,
                  absolute_path = excluded.absolute_path,
                  display_name = excluded.display_name,
                  deleted_at = excluded.deleted_at,
                  last_seen_at = excluded.last_seen_at
                ON CONFLICT(source_id, absolute_path) DO UPDATE SET
                  id = excluded.id,
                  content_hash = excluded.content_hash,
                  relative_path = excluded.relative_path,
                  display_name = excluded.display_name,
                  deleted_at = excluded.deleted_at,
                  last_seen_at = excluded.last_seen_at
                ",
            )
            .map_err(|error| error.to_string())?;

        for item in items {
            asset_stmt
                .execute(params![
                    item.content_hash,
                    item.kind,
                    item.mime_type,
                    item.size_bytes,
                    item.width,
                    item.height,
                    item.duration_ms,
                    item.captured_at,
                    item.captured_at_source,
                    item.latitude,
                    item.longitude,
                    item.geo_source,
                    item.thumbnail_key,
                    item.deleted_at,
                    item.last_seen_at
                ])
                .map_err(|error| error.to_string())?;

            for location in &item.locations {
                let absolute_path = location
                    .absolute_path
                    .clone()
                    .or_else(|| location.relative_path.clone())
                    .unwrap_or_else(|| location.id.clone());
                location_stmt
                    .execute(params![
                        location.id,
                        item.content_hash,
                        location.source_id,
                        location.relative_path,
                        absolute_path,
                        location.display_name,
                        location.deleted_at,
                        location.last_seen_at
                    ])
                    .map_err(|error| error.to_string())?;
            }
        }
    }
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

    if let Some(kind) = query.kind.as_ref().filter(|kind| *kind != "all") {
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
        SELECT a.content_hash, a.latitude, a.longitude, a.captured_at
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
                    ImportProgress {
                        phase: "counting".to_string(),
                        source_label: source_label.clone(),
                        scanned_files: 0,
                        total_files,
                        accepted_media: 0,
                        skipped_files: 0,
                        current_path: None,
                    },
                );
            }
        }
    }

    let mut items = Vec::<MediaItem>::new();
    let mut errors = Vec::<String>::new();
    let mut scanned_files = 0_i64;
    let mut accepted_media = 0_i64;
    let mut skipped_files = 0_i64;

    emit_progress(
        &window,
        ImportProgress {
            phase: "scanning".to_string(),
            source_label: source_label.clone(),
            scanned_files,
            total_files,
            accepted_media,
            skipped_files,
            current_path: None,
        },
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
                items.push(item);
                accepted_media += 1;
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
                ImportProgress {
                    phase: "scanning".to_string(),
                    source_label: source_label.clone(),
                    scanned_files,
                    total_files,
                    accepted_media,
                    skipped_files,
                    current_path: Some(current_path),
                },
            );
        }
    }

    emit_progress(
        &window,
        ImportProgress {
            phase: "storing".to_string(),
            source_label: source_label.clone(),
            scanned_files,
            total_files,
            accepted_media,
            skipped_files,
            current_path: None,
        },
    );

    let mut conn = connect(&app)?;
    upsert_source_tx(&conn, &source)?;
    upsert_media_tx(&mut conn, &items)?;

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
            list_sources,
            remove_sources,
            count_media,
            clear_catalog,
            import_folder,
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
