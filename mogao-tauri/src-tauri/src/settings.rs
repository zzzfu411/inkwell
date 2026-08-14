//! Inkwell local settings with user-writable release storage and serialized updates.

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub client_cfg: Option<Value>,
    #[serde(default)]
    pub ui_state: Option<Value>,
}

static SETTINGS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn manifest_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn release_data_dir_from(
    local_app_data: Option<OsString>,
    app_data: Option<OsString>,
    home: Option<OsString>,
    _xdg_config: Option<OsString>,
) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = local_app_data.or(app_data) {
            return PathBuf::from(path).join("Inkwell");
        }
        if let Some(path) = home {
            return PathBuf::from(path)
                .join("AppData")
                .join("Local")
                .join("Inkwell");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (local_app_data, app_data, _xdg_config);
        if let Some(path) = home {
            return PathBuf::from(path)
                .join("Library")
                .join("Application Support")
                .join("Inkwell");
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (local_app_data, app_data);
        if let Some(path) = _xdg_config {
            return PathBuf::from(path).join("inkwell");
        }
        if let Some(path) = home {
            return PathBuf::from(path).join(".config").join("inkwell");
        }
    }
    std::env::temp_dir().join("Inkwell")
}

pub fn data_dir() -> PathBuf {
    if let Some(path) = env_path("INKWELL_DATA_DIR") {
        return path;
    }
    if cfg!(debug_assertions) {
        return manifest_data_dir();
    }
    release_data_dir_from(
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("APPDATA"),
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")),
        std::env::var_os("XDG_CONFIG_HOME"),
    )
}

pub fn settings_path() -> PathBuf {
    data_dir().join("mogao-settings.json")
}

fn legacy_settings_paths(current: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("mogao-settings.json"));
        }
    }
    paths.push(manifest_data_dir().join("mogao-settings.json"));
    paths.retain(|path| path != current);
    paths.dedup();
    paths
}

fn read_settings(path: &Path) -> Option<Settings> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn secret_path(settings: &Path) -> PathBuf {
    settings.with_file_name("api-key.dpapi")
}

fn secret_backup_path(settings: &Path) -> PathBuf {
    settings.with_file_name("api-key.dpapi.bak")
}

fn install_file_with_backup(tmp: &Path, destination: &Path, backup: &Path) -> Result<()> {
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(backup).with_context(|| format!("clear {}", backup.display()))?;
        }
        fs::rename(destination, backup)
            .with_context(|| format!("backup {}", destination.display()))?;
    }
    if let Err(error) = fs::rename(tmp, destination) {
        if !destination.exists() && backup.exists() {
            fs::rename(backup, destination)
                .with_context(|| format!("restore {}", destination.display()))?;
        }
        return Err(error).with_context(|| format!("install {}", destination.display()));
    }
    if backup.exists() {
        fs::remove_file(backup).with_context(|| format!("clear {}", backup.display()))?;
    }
    Ok(())
}

fn api_key(settings: &Settings) -> Option<String> {
    settings
        .client_cfg
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|cfg| cfg.get("apiKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

fn set_api_key(settings: &mut Settings, key: String) {
    let mut cfg = settings
        .client_cfg
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    cfg.insert("apiKey".to_string(), Value::String(key));
    settings.client_cfg = Some(Value::Object(cfg));
}

fn remove_api_key(settings: &mut Settings) {
    if let Some(Value::Object(cfg)) = settings.client_cfg.as_mut() {
        cfg.remove("apiKey");
    }
}

#[cfg(target_os = "windows")]
fn protect_secret(plain: &[u8]) -> Result<Vec<u8>> {
    use std::ptr::null;
    use std::slice;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plain.len().try_into().context("API key is too large")?,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error()).context("encrypt API key with Windows DPAPI");
    }
    let encrypted =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(encrypted)
}

#[cfg(target_os = "windows")]
fn unprotect_secret(encrypted: &[u8]) -> Result<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use std::slice;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: encrypted
            .len()
            .try_into()
            .context("encrypted API key is too large")?,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error()).context("decrypt API key with Windows DPAPI");
    }
    let plain = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(plain)
}

#[cfg(not(target_os = "windows"))]
fn protect_secret(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_secret(encrypted: &[u8]) -> Result<Vec<u8>> {
    Ok(encrypted.to_vec())
}

pub fn credential_storage() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-dpapi"
    } else {
        "private-file"
    }
}

fn load_settings_unlocked(path: &Path) -> Settings {
    let backup = path.with_extension("json.bak");
    let mut settings = read_settings(path)
        .or_else(|| read_settings(&backup))
        .or_else(|| {
            legacy_settings_paths(path)
                .into_iter()
                .find_map(|legacy| read_settings(&legacy))
        })
        .unwrap_or_default();

    let mut loaded_secret = false;
    for secret in [secret_path(path), secret_backup_path(path)] {
        if let Ok(encrypted) = fs::read(&secret) {
            match unprotect_secret(&encrypted)
                .and_then(|plain| String::from_utf8(plain).context("API key is not valid UTF-8"))
            {
                Ok(key) => {
                    set_api_key(&mut settings, key);
                    loaded_secret = true;
                    break;
                }
                Err(error) => eprintln!(
                    "[inkwell] unable to load encrypted API key from {}: {error:#}",
                    secret.display()
                ),
            }
        }
    }
    if !loaded_secret && api_key(&settings).is_some() {
        // One-time migration from old plaintext JSON or a legacy settings file.
        if let Err(error) = save_settings_unlocked(path, &settings) {
            eprintln!("[inkwell] unable to migrate plaintext API key: {error:#}");
        }
    }
    settings
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    file.write_all(contents)
        .with_context(|| format!("write {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("sync {}", path.display()))?;
    Ok(())
}

fn save_settings_unlocked(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let key = api_key(settings);
    let mut persisted = settings.clone();
    remove_api_key(&mut persisted);
    if let Some(key) = key.as_ref() {
        let protected = protect_secret(key.as_bytes())?;
        let secret = secret_path(path);
        let backup = secret_backup_path(path);
        let tmp = secret.with_extension("dpapi.tmp");
        write_private_file(&tmp, &protected)?;
        install_file_with_backup(&tmp, &secret, &backup)?;
    }

    let mut bytes = serde_json::to_vec_pretty(&persisted)?;
    bytes.push(b'\n');
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    write_private_file(&tmp, &bytes)?;

    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).with_context(|| format!("backup {}", path.display()))?;
    }
    if let Err(error) = fs::rename(&tmp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error).with_context(|| format!("install {}", path.display()));
    }
    let _ = fs::remove_file(backup);
    if key.is_none() {
        for secret in [secret_path(path), secret_backup_path(path)] {
            if secret.exists() {
                fs::remove_file(&secret).with_context(|| format!("clear {}", secret.display()))?;
            }
        }
    }
    Ok(())
}

pub fn load_settings() -> Settings {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_settings_unlocked(&settings_path())
}

pub fn update_settings<F>(mutator: F) -> Result<Settings>
where
    F: FnOnce(&mut Settings),
{
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = settings_path();
    let mut settings = load_settings_unlocked(&path);
    mutator(&mut settings);
    save_settings_unlocked(&path, &settings)?;
    Ok(settings)
}

pub fn save_vault_path(vault: &Path) -> Result<()> {
    update_settings(|settings| {
        settings.vault_path = Some(vault.to_string_lossy().to_string());
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_settings_path(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("inkwell-settings-{tag}-{stamp}"))
            .join("mogao-settings.json")
    }

    #[test]
    fn update_transaction_preserves_all_concurrent_fields() {
        let path = Arc::new(temp_settings_path("concurrent"));
        let mut workers = Vec::new();
        for index in 0..12 {
            let path = path.clone();
            workers.push(thread::spawn(move || {
                let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                let mut settings = load_settings_unlocked(&path);
                let mut cfg = settings
                    .client_cfg
                    .take()
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                cfg.insert(format!("field{index}"), json!(index));
                settings.client_cfg = Some(Value::Object(cfg));
                save_settings_unlocked(&path, &settings).unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let saved = read_settings(&path).unwrap();
        let cfg = saved.client_cfg.unwrap();
        for index in 0..12 {
            assert_eq!(cfg[format!("field{index}")], index);
        }
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn legacy_settings_are_read_without_deleting_the_source() {
        let root = temp_settings_path("migration");
        let legacy = root.with_file_name("legacy.json");
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(&legacy, r#"{"vaultPath":"legacy-vault"}"#).unwrap();
        let loaded = read_settings(&legacy).unwrap();
        save_settings_unlocked(&root, &loaded).unwrap();
        assert_eq!(
            read_settings(&root).unwrap().vault_path.as_deref(),
            Some("legacy-vault")
        );
        assert!(
            legacy.is_file(),
            "migration must retain the legacy file for rollback"
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn api_key_is_not_written_to_settings_json() {
        let path = temp_settings_path("secret");
        let settings = Settings {
            client_cfg: Some(json!({"apiKey":"super-secret", "model":"gemini-3.6-flash"})),
            ..Settings::default()
        };
        save_settings_unlocked(&path, &settings).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("super-secret"));
        assert!(!raw.contains("apiKey"));
        assert!(secret_path(&path).is_file());
        let loaded = load_settings_unlocked(&path);
        assert_eq!(api_key(&loaded).as_deref(), Some("super-secret"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn secret_install_restores_previous_file_when_rename_fails() {
        let path = temp_settings_path("secret-install-failure");
        let secret = secret_path(&path);
        let backup = secret_backup_path(&path);
        let missing_tmp = secret.with_extension("missing.tmp");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&secret, b"previous-secret").unwrap();

        assert!(install_file_with_backup(&missing_tmp, &secret, &backup).is_err());
        assert_eq!(fs::read(&secret).unwrap(), b"previous-secret");
        assert!(!backup.exists());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn interrupted_secret_install_can_load_backup() {
        let path = temp_settings_path("secret-backup-recovery");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}\n").unwrap();
        fs::write(
            secret_backup_path(&path),
            protect_secret(b"backup-secret").unwrap(),
        )
        .unwrap();

        let loaded = load_settings_unlocked(&path);
        assert_eq!(api_key(&loaded).as_deref(), Some("backup-secret"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_dpapi_roundtrip() {
        let encrypted = protect_secret(b"roundtrip-secret").unwrap();
        assert_ne!(encrypted, b"roundtrip-secret");
        assert_eq!(unprotect_secret(&encrypted).unwrap(), b"roundtrip-secret");
    }
}
