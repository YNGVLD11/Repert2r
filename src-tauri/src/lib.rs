mod separator;

use separator::{separate_mdx, SeparatedStems, StemState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryItem {
    id: String,
    name: String,
    path: String,
    hash: String,
    modified_ms: u64,
    size_bytes: u64,
    ext: String,
    #[serde(default)]
    key_label: String,
    #[serde(default)]
    bpm: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectedFile {
    path: String,
    name: String,
    file_name: String,
    ext: String,
    hash: String,
    modified_ms: u64,
    created_ms: u64,
    size_bytes: u64,
    exists: bool,
}

fn system_time_ms(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn compute_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{:02x}", b)).collect())
}

fn library_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.json"))
}

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<Vec<LibraryItem>, String> {
    let path = library_file_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, items: Vec<LibraryItem>) -> Result<(), String> {
    let path = library_file_path(&app)?;
    let content = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
struct ImportProgress {
    current: usize,
    total: usize,
}

#[tauri::command]
async fn inspect_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<InspectedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let _ = app.emit("library-import-progress", ImportProgress { current: 0, total });
        let mut out = Vec::new();
        for (idx, raw) in paths.into_iter().enumerate() {
            let p = PathBuf::from(&raw);
            if let Ok(meta) = fs::metadata(&p) {
                if meta.is_file() {
                    let file_name = p
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let name = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&file_name)
                        .to_string();
                    let ext = p
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if let Ok(hash) = compute_sha256(&p) {
                        out.push(InspectedFile {
                            path: raw,
                            name,
                            file_name,
                            ext,
                            hash,
                            modified_ms: system_time_ms(meta.modified()),
                            created_ms: system_time_ms(meta.created()),
                            size_bytes: meta.len(),
                            exists: true,
                        });
                    }
                }
            }
            let _ = app.emit(
                "library-import-progress",
                ImportProgress {
                    current: idx + 1,
                    total,
                },
            );
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_file_props(path: String) -> InspectedFile {
    let p = PathBuf::from(&path);
    let file_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let name = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&file_name)
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    match fs::metadata(&p) {
        Ok(meta) => InspectedFile {
            path: path.clone(),
            name,
            file_name,
            ext,
            hash: compute_sha256(&p).unwrap_or_default(),
            modified_ms: system_time_ms(meta.modified()),
            created_ms: system_time_ms(meta.created()),
            size_bytes: meta.len(),
            exists: true,
        },
        Err(_) => InspectedFile {
            path,
            name,
            file_name,
            ext,
            hash: String::new(),
            modified_ms: 0,
            created_ms: 0,
            size_bytes: 0,
            exists: false,
        },
    }
}

#[tauri::command]
fn read_audio_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = Path::new(&path).parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn separate_track(
    app: tauri::AppHandle,
    state: tauri::State<'_, StemState>,
    request: tauri::ipc::Request<'_>,
) -> Result<usize, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("Expected binary audio body".into()),
    };
    if raw.len() % 8 != 0 {
        return Err("Invalid stereo f32 PCM length".into());
    }
    let total_floats = raw.len() / 4;
    let sample_count = total_floats / 2;
    let mut floats = Vec::with_capacity(total_floats);
    for chunk in raw.chunks_exact(4) {
        floats.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    let (left, right) = floats.split_at(sample_count);
    let left_vec = left.to_vec();
    let right_vec = right.to_vec();
    let app_clone = app.clone();

    let (vocals, instrumental) = tauri::async_runtime::spawn_blocking(move || {
        separate_mdx(&app_clone, &left_vec, &right_vec)
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(SeparatedStems {
        sample_count,
        vocals,
        instrumental,
    });
    Ok(sample_count)
}

#[tauri::command]
fn get_stem(state: tauri::State<'_, StemState>, kind: String) -> Result<tauri::ipc::Response, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let stems = guard.as_ref().ok_or("Дорожки ещё не извлечены")?;
    let slice = match kind.as_str() {
        "vocals" => &stems.vocals,
        "instrumental" => &stems.instrumental,
        _ => return Err("Unknown stem kind".into()),
    };
    let mut bytes = Vec::with_capacity(slice.len() * 4);
    for &f in slice {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn clear_stems(state: tauri::State<'_, StemState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StemState(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            inspect_files,
            get_file_props,
            read_audio_file,
            reveal_in_folder,
            separate_track,
            get_stem,
            clear_stems
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
