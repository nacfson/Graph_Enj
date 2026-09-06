//! Cursor Agent orchestrator — interactive Terminal session + optional headless smoke.

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const DEFAULT_SMOKE_PROMPT: &str =
    "Reply with one short sentence confirming Graph_Enj can reach Cursor Agent. Do not modify any files.";

const SESSION_POLL_ATTEMPTS: u32 = 60;
const SESSION_POLL_MS: u64 = 500;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorProbe {
    pub available: bool,
    pub authenticated: bool,
    pub program: Option<String>,
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStartResult {
    pub run_id: String,
    pub node_id: String,
    pub pid: Option<u32>,
    pub program: String,
    pub display: String,
    pub cwd: String,
    pub mode: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStdoutEvent {
    pub run_id: String,
    pub node_id: String,
    pub stream: String,
    pub line: String,
    pub at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStatusEvent {
    pub run_id: String,
    pub node_id: String,
    pub status: String,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
    pub session_id: Option<String>,
    pub source: String,
    pub at: String,
}

struct ManagedChild {
    child: Child,
    node_id: String,
}

pub struct OrchestratorState {
    children: Mutex<HashMap<String, ManagedChild>>,
    /// App name last used for interactive launch (for Focus).
    last_terminal_app: Mutex<Option<String>>,
}

impl Default for OrchestratorState {
    fn default() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            last_terminal_app: Mutex::new(None),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalKind {
    AppleTerminal,
    ITerm,
    Ghostty,
    Kitty,
    Warp,
    Alacritty,
    WezTerm,
    Generic,
}

#[derive(Clone, Debug)]
struct PreferredTerminal {
    /// Name suitable for `open -a` / AppleScript (e.g. "Ghostty").
    app_name: String,
    kind: TerminalKind,
}

fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn home_local_bin() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".local/bin"))
}

fn resolve_agent_program() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(local) = home_local_bin() {
        candidates.push(local.join("agent"));
        candidates.push(local.join("cursor-agent"));
    }
    candidates.push(PathBuf::from("agent"));
    candidates.push(PathBuf::from("cursor-agent"));

    for candidate in candidates {
        if candidate.is_absolute() {
            if candidate.is_file() {
                return Ok(candidate);
            }
        } else {
            let mut cmd = Command::new("which");
            cmd.arg(&candidate);
            if let Some(local) = home_local_bin() {
                let path = std::env::var("PATH").unwrap_or_default();
                cmd.env("PATH", format!("{}:{path}", local.display()));
            }
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !found.is_empty() && Path::new(&found).is_file() {
                        return Ok(PathBuf::from(found));
                    }
                }
            }
        }
    }

    Err("Neither `agent` nor `cursor-agent` found on PATH (checked ~/.local/bin)".into())
}

fn agent_env(cmd: &mut Command) {
    if let Some(local) = home_local_bin() {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{path}", local.display()));
    }
}

fn workspace_chat_dir(cwd: &Path) -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "HOME is unset".to_string())?;
    let abs = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf());
    let mut hasher = Md5::new();
    hasher.update(abs.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok(home.join(".cursor/chats").join(hex))
}

fn list_session_ids(chat_dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(entries) = fs::read_dir(chat_dir) else {
        return ids;
    };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                ids.insert(name.to_string());
            }
        }
    }
    ids
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalize_terminal_app_name(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
    let name = trimmed
        .strip_suffix(".app")
        .unwrap_or(trimmed)
        .trim()
        .to_string();
    name
}

fn terminal_kind_for_name(app_name: &str) -> TerminalKind {
    let lower = app_name.to_ascii_lowercase();
    match lower.as_str() {
        "terminal" => TerminalKind::AppleTerminal,
        "iterm" | "iterm2" => TerminalKind::ITerm,
        "ghostty" => TerminalKind::Ghostty,
        "kitty" => TerminalKind::Kitty,
        "warp" => TerminalKind::Warp,
        "alacritty" => TerminalKind::Alacritty,
        "wezterm" => TerminalKind::WezTerm,
        _ => TerminalKind::Generic,
    }
}

fn terminal_kind_for_bundle_id(bundle_id: &str) -> Option<TerminalKind> {
    match bundle_id {
        "com.apple.Terminal" => Some(TerminalKind::AppleTerminal),
        "com.googlecode.iterm2" => Some(TerminalKind::ITerm),
        "com.mitchellh.ghostty" => Some(TerminalKind::Ghostty),
        "net.kovidgoyal.kitty" => Some(TerminalKind::Kitty),
        "dev.warp.Warp-Stable" | "dev.warp.Warp" => Some(TerminalKind::Warp),
        "org.alacritty" | "io.alacritty" => Some(TerminalKind::Alacritty),
        "com.github.wez.wezterm" => Some(TerminalKind::WezTerm),
        _ => None,
    }
}

fn app_name_for_bundle_id(bundle_id: &str) -> Option<String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "POSIX path of (path to application id \"{bundle_id}\")"
        ))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    let pb = PathBuf::from(path.trim_end_matches('/'));
    let name = pb.file_stem()?.to_str()?.to_string();
    Some(name)
}

fn app_exists(app_name: &str) -> bool {
    let candidates = [
        PathBuf::from(format!("/Applications/{app_name}.app")),
        home_dir()
            .map(|h| h.join(format!("Applications/{app_name}.app")))
            .unwrap_or_default(),
    ];
    if candidates.iter().any(|p| p.is_dir()) {
        return true;
    }
    // Last resort: Launch Services resolution
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!("id of application \"{app_name}\""))
        .output();
    matches!(output, Ok(o) if o.status.success())
}

fn read_osx_exec_from_settings(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    // Settings may contain comments; pull the first string value for the key.
    let key = "terminal.external.osxExec";
    let idx = text.find(key)?;
    let after = &text[idx + key.len()..];
    let colon = after.find(':')?;
    let mut rest = after[colon + 1..].trim_start();
    if rest.starts_with('"') {
        rest = &rest[1..];
        let end = rest.find('"')?;
        let value = normalize_terminal_app_name(&rest[..end]);
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn launch_services_unix_executable_handler() -> Option<String> {
    let home = home_dir()?;
    let plist = home
        .join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    if !plist.is_file() {
        return None;
    }
    // Avoid a plist crate dependency — use a tiny Python helper.
    let script = r#"
import plistlib, sys
path = sys.argv[1]
with open(path, "rb") as f:
    data = plistlib.load(f)
for h in data.get("LSHandlers", []):
    if h.get("LSHandlerContentType") == "public.unix-executable":
        bid = h.get("LSHandlerRoleAll") or h.get("LSHandlerRoleViewer")
        if bid:
            print(bid)
            break
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let bid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if bid.is_empty() {
        None
    } else {
        Some(bid)
    }
}

fn preferred_from_app_name(app_name: &str) -> Option<PreferredTerminal> {
    let name = normalize_terminal_app_name(app_name);
    if name.is_empty() || !app_exists(&name) {
        return None;
    }
    Some(PreferredTerminal {
        app_name: name.clone(),
        kind: terminal_kind_for_name(&name),
    })
}

fn resolve_preferred_terminal() -> PreferredTerminal {
    // 1) Explicit override
    if let Ok(raw) = std::env::var("GRAPH_ENJ_TERMINAL") {
        if let Some(t) = preferred_from_app_name(&raw) {
            return t;
        }
    }

    // 2) Cursor / VS Code "Open in External Terminal" setting
    if let Some(home) = home_dir() {
        let settings_paths = [
            home.join("Library/Application Support/Cursor/User/settings.json"),
            home.join("Library/Application Support/Code/User/settings.json"),
        ];
        for path in settings_paths {
            if let Some(name) = read_osx_exec_from_settings(&path) {
                if let Some(t) = preferred_from_app_name(&name) {
                    return t;
                }
            }
        }
    }

    // 3) Launch Services default for unix executables (user's preferred terminal)
    if let Some(bundle_id) = launch_services_unix_executable_handler() {
        if let Some(name) = app_name_for_bundle_id(&bundle_id) {
            let kind = terminal_kind_for_bundle_id(&bundle_id)
                .unwrap_or_else(|| terminal_kind_for_name(&name));
            if app_exists(&name) {
                return PreferredTerminal {
                    app_name: name,
                    kind,
                };
            }
        }
    }

    // 4) First installed common terminal (never prefer Terminal.app early)
    for name in [
        "Ghostty",
        "kitty",
        "iTerm",
        "Warp",
        "Alacritty",
        "WezTerm",
        "Terminal",
    ] {
        if let Some(t) = preferred_from_app_name(name) {
            return t;
        }
    }

    PreferredTerminal {
        app_name: "Terminal".into(),
        kind: TerminalKind::AppleTerminal,
    }
}

fn write_launch_script(shell_command: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("graph-enj");
    fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let path = dir.join(format!("orch-{}.sh", Uuid::new_v4()));
    let body = format!("#!/bin/zsh\nset -e\n{shell_command}\n");
    fs::write(&path, body).map_err(|e| format!("write launch script: {e}"))?;
    let status = Command::new("chmod")
        .arg("+x")
        .arg(&path)
        .status()
        .map_err(|e| format!("chmod: {e}"))?;
    if !status.success() {
        return Err("chmod +x on launch script failed".into());
    }
    Ok(path)
}

fn open_with_apple_terminal(shell_command: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"Terminal\"\n  do script \"{cmd}\"\n  activate\nend tell",
        cmd = applescript_escape(shell_command)
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Terminal launch failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn open_with_iterm(shell_command: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"{app}\"\n  activate\n  create window with default profile command \"{cmd}\"\nend tell",
        app = if app_exists("iTerm2") {
            "iTerm2"
        } else {
            "iTerm"
        },
        cmd = applescript_escape(shell_command)
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "iTerm launch failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn resolve_app_path(app_name: &str) -> Option<PathBuf> {
    let candidates = [
        PathBuf::from(format!("/Applications/{app_name}.app")),
        home_dir()
            .map(|h| h.join(format!("Applications/{app_name}.app")))
            .unwrap_or_default(),
    ];
    candidates.into_iter().find(|p| p.is_dir()).or_else(|| {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "POSIX path of (path to application \"{app_name}\")"
            ))
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return None;
        }
        Some(PathBuf::from(path.trim_end_matches('/')))
    })
}

fn open_via_open_args(app_name: &str, args: &[&str]) -> Result<(), String> {
    let app_path = resolve_app_path(app_name)
        .unwrap_or_else(|| PathBuf::from(format!("/Applications/{app_name}.app")));
    let mut cmd = Command::new("open");
    cmd.arg("-na").arg(&app_path).arg("--args");
    for a in args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("open failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "open {app_name} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn open_with_ghostty(cwd: &str, shell_command: &str) -> Result<(), String> {
    // Native AppleScript gives a real Ghostty surface (theme, window size,
    // shell-integration). `open --args -e /bin/zsh script` starts a non-interactive
    // ~80x24 session that makes Agent/Codex TUIs look broken.
    let script = format!(
        "tell application \"Ghostty\"\n\
           activate\n\
           set cfg to new surface configuration\n\
           set initial working directory of cfg to \"{cwd}\"\n\
           set initial input of cfg to \"{cmd}\" & return\n\
           new window with configuration cfg\n\
         end tell",
        cwd = applescript_escape(cwd),
        cmd = applescript_escape(shell_command),
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Ghostty AppleScript launch failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn open_via_interactive_shell(
    app_name: &str,
    kind: TerminalKind,
    cwd: &str,
    shell_command: &str,
) -> Result<(), String> {
    let wrapped = format!(
        "cd {cwd} && {cmd}",
        cwd = shell_single_quote(cwd),
        cmd = shell_command
    );

    match kind {
        TerminalKind::Kitty => open_via_open_args(
            app_name,
            &["--directory", cwd, "/bin/zsh", "-lic", &wrapped],
        ),
        TerminalKind::Alacritty | TerminalKind::WezTerm => {
            open_via_open_args(app_name, &["-e", "/bin/zsh", "-lic", &wrapped])
        }
        TerminalKind::Warp | TerminalKind::Generic => {
            let script = write_launch_script(&wrapped)?;
            let app_path = resolve_app_path(app_name)
                .unwrap_or_else(|| PathBuf::from(format!("/Applications/{app_name}.app")));
            let output = Command::new("open")
                .arg("-a")
                .arg(&app_path)
                .arg(&script)
                .output()
                .map_err(|e| format!("open failed: {e}"))?;
            if !output.status.success() {
                open_via_open_args(app_name, &["-e", "/bin/zsh", "-lic", &wrapped])?;
            }
            Ok(())
        }
        _ => Err(format!("interactive shell launch not supported for {app_name}")),
    }
}

fn open_terminal_with_command(
    terminal: &PreferredTerminal,
    cwd: &str,
    shell_command: &str,
) -> Result<(), String> {
    match terminal.kind {
        TerminalKind::AppleTerminal => {
            let full = format!(
                "cd {cwd} && {cmd}",
                cwd = shell_single_quote(cwd),
                cmd = shell_command
            );
            open_with_apple_terminal(&full)
        }
        TerminalKind::ITerm => {
            let full = format!(
                "cd {cwd} && {cmd}",
                cwd = shell_single_quote(cwd),
                cmd = shell_command
            );
            open_with_iterm(&full)
        }
        TerminalKind::Ghostty => open_with_ghostty(cwd, shell_command),
        TerminalKind::Kitty
        | TerminalKind::Alacritty
        | TerminalKind::WezTerm
        | TerminalKind::Warp
        | TerminalKind::Generic => {
            open_via_interactive_shell(&terminal.app_name, terminal.kind, cwd, shell_command)
        }
    }
}

fn focus_terminal_app(app_name: &str) -> Result<(), String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!("tell application \"{app_name}\" to activate"))
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !output.status.success() {
        // open -a is a solid fallback
        let output = Command::new("open")
            .arg("-a")
            .arg(format!("{app_name}.app"))
            .output()
            .map_err(|e| format!("open failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Focus terminal failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn probe_cursor_agent() -> CursorProbe {
    let program = match resolve_agent_program() {
        Ok(p) => p,
        Err(err) => {
            return CursorProbe {
                available: false,
                authenticated: false,
                program: None,
                detail: err,
            };
        }
    };

    let mut version_cmd = Command::new(&program);
    agent_env(&mut version_cmd);
    let version = match version_cmd.arg("--version").output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string(),
        Ok(output) => format!(
            "version check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(err) => format!("version check error: {err}"),
    };

    let mut status_cmd = Command::new(&program);
    agent_env(&mut status_cmd);
    let (authenticated, status_detail) = match status_cmd.arg("status").output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let text = if !stdout.is_empty() { stdout } else { stderr };
            let ok = output.status.success() && text.to_lowercase().contains("logged in");
            (ok, text)
        }
        Err(err) => (false, format!("status error: {err}")),
    };

    CursorProbe {
        available: true,
        authenticated,
        program: Some(program.display().to_string()),
        detail: if status_detail.is_empty() {
            version
        } else {
            format!("{version} · {status_detail}")
        },
    }
}

/// Open interactive Cursor Agent in the user's preferred terminal and bind session id.
#[tauri::command]
pub fn open_orchestrator_session(
    app: AppHandle,
    state: State<'_, Arc<OrchestratorState>>,
    node_id: String,
    cwd: String,
) -> Result<OrchestratorStartResult, String> {
    let program = resolve_agent_program()?;
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    let abs_cwd = cwd_path
        .canonicalize()
        .unwrap_or_else(|_| cwd_path.clone());
    let abs_cwd_str = abs_cwd.display().to_string();

    let chat_dir = workspace_chat_dir(&abs_cwd)?;
    let before = list_session_ids(&chat_dir);

    let terminal = resolve_preferred_terminal();
    let agent_cmd = format!(
        "{agent} --workspace {cwd} --trust",
        cwd = shell_single_quote(&abs_cwd_str),
        agent = shell_single_quote(&program.display().to_string()),
    );
    let display = format!("{} @ {}: {agent_cmd}", terminal.app_name, abs_cwd_str);

    open_terminal_with_command(&terminal, &abs_cwd_str, &agent_cmd)?;
    if let Ok(mut last) = state.last_terminal_app.lock() {
        *last = Some(terminal.app_name.clone());
    }

    let run_id = Uuid::new_v4().to_string();

    let _ = app.emit(
        "orchestrator://status",
        OrchestratorStatusEvent {
            run_id: run_id.clone(),
            node_id: node_id.clone(),
            status: "running".into(),
            message: Some(format!(
                "Interactive Cursor Agent opened in {}",
                terminal.app_name
            )),
            exit_code: None,
            session_id: None,
            source: "adapter".into(),
            at: now_iso(),
        },
    );
    let _ = app.emit(
        "orchestrator://stdout",
        OrchestratorStdoutEvent {
            run_id: run_id.clone(),
            node_id: node_id.clone(),
            stream: "info".into(),
            line: format!("launched via {}: {display}", terminal.app_name),
            at: now_iso(),
        },
    );
    let _ = app.emit(
        "orchestrator://stdout",
        OrchestratorStdoutEvent {
            run_id: run_id.clone(),
            node_id: node_id.clone(),
            stream: "info".into(),
            line: format!(
                "waiting for session under {}",
                chat_dir.display()
            ),
            at: now_iso(),
        },
    );

    if let Ok(dir) = app.path().app_data_dir() {
        let runs = dir.join("runs");
        let _ = fs::create_dir_all(&runs);
        let record = serde_json::json!({
            "id": run_id,
            "graphId": "interactive-orchestrator",
            "graphName": "Orchestrator Terminal Session",
            "repoPath": abs_cwd_str,
            "status": "running",
            "mode": "interactive",
            "terminalApp": terminal.app_name,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        });
        let _ = fs::write(
            runs.join(format!("{run_id}.json")),
            serde_json::to_string_pretty(&record).unwrap_or_default(),
        );
    }

    let app_poll = app.clone();
    let run_poll = run_id.clone();
    let node_poll = node_id.clone();
    let chat_poll = chat_dir.clone();
    thread::spawn(move || {
        for _ in 0..SESSION_POLL_ATTEMPTS {
            thread::sleep(Duration::from_millis(SESSION_POLL_MS));
            let after = list_session_ids(&chat_poll);
            let mut created: Vec<_> = after.difference(&before).cloned().collect();
            if created.is_empty() {
                // Fallback: newest session by meta/store mtime if any appeared after launch.
                continue;
            }
            created.sort();
            let session_id = created.pop().unwrap_or_default();
            let _ = app_poll.emit(
                "orchestrator://status",
                OrchestratorStatusEvent {
                    run_id: run_poll.clone(),
                    node_id: node_poll.clone(),
                    status: "running".into(),
                    message: Some(format!("Bound session {session_id}")),
                    exit_code: None,
                    session_id: Some(session_id.clone()),
                    source: "adapter".into(),
                    at: now_iso(),
                },
            );
            let _ = app_poll.emit(
                "orchestrator://stdout",
                OrchestratorStdoutEvent {
                    run_id: run_poll,
                    node_id: node_poll,
                    stream: "info".into(),
                    line: format!("session bound: {session_id}"),
                    at: now_iso(),
                },
            );
            return;
        }

        // Fallback: pick newest directory by modified time even if it existed
        // (agent may have reused / resumed). Prefer any dir with recent store.db.
        if let Ok(entries) = fs::read_dir(&chat_poll) {
            let mut newest: Option<(SystemTime, String)> = None;
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = match entry.file_name().to_str() {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                let marker = path.join("store.db");
                let meta = marker.metadata().or_else(|_| path.metadata());
                if let Ok(m) = meta {
                    if let Ok(modified) = m.modified() {
                        let replace = match &newest {
                            None => true,
                            Some((t, _)) => modified > *t,
                        };
                        if replace {
                            newest = Some((modified, name));
                        }
                    }
                }
            }
            if let Some((_, session_id)) = newest {
                if !before.contains(&session_id) || before.is_empty() {
                    let _ = app_poll.emit(
                        "orchestrator://status",
                        OrchestratorStatusEvent {
                            run_id: run_poll.clone(),
                            node_id: node_poll.clone(),
                            status: "running".into(),
                            message: Some(format!("bound session {session_id} (mtime fallback)")),
                            exit_code: None,
                            session_id: Some(session_id.clone()),
                            source: "heuristic".into(),
                            at: now_iso(),
                        },
                    );
                    let _ = app_poll.emit(
                        "orchestrator://stdout",
                        OrchestratorStdoutEvent {
                            run_id: run_poll,
                            node_id: node_poll,
                            stream: "info".into(),
                            line: format!("session bound (fallback): {session_id}"),
                            at: now_iso(),
                        },
                    );
                    return;
                }
            }
        }

        let _ = app_poll.emit(
            "orchestrator://stdout",
            OrchestratorStdoutEvent {
                run_id: run_poll,
                node_id: node_poll,
                stream: "info".into(),
                line: "session id not discovered yet — paste/bind manually if needed".into(),
                at: now_iso(),
            },
        );
    });

    Ok(OrchestratorStartResult {
        run_id,
        node_id,
        pid: None,
        program: program.display().to_string(),
        display,
        cwd: abs_cwd_str,
        mode: "interactive".into(),
        session_id: None,
    })
}

#[tauri::command]
pub fn focus_orchestrator_terminal(
    state: State<'_, Arc<OrchestratorState>>,
) -> Result<(), String> {
    let app_name = state
        .last_terminal_app
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_else(|| resolve_preferred_terminal().app_name);
    focus_terminal_app(&app_name)
}

/// Headless smoke test (dev). Prefer `open_orchestrator_session` for real work.
#[tauri::command]
pub fn start_orchestrator_smoke(
    app: AppHandle,
    state: State<'_, Arc<OrchestratorState>>,
    node_id: String,
    cwd: String,
    smoke_prompt: Option<String>,
) -> Result<OrchestratorStartResult, String> {
    {
        let children = state.children.lock().map_err(|e| e.to_string())?;
        if !children.is_empty() {
            return Err("An orchestrator smoke process is already running. Stop it first.".into());
        }
    }

    let program = resolve_agent_program()?;
    let prompt = smoke_prompt
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SMOKE_PROMPT.to_string());

    let args = vec![
        "-p".to_string(),
        "--mode=ask".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        prompt,
    ];

    let display = format!("{} {}", program.display(), args.join(" "));
    let run_id = Uuid::new_v4().to_string();
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }

    let mut cmd = Command::new(&program);
    agent_env(&mut cmd);
    cmd.args(&args)
        .current_dir(&cwd_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", program.display()))?;

    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture stderr".to_string())?;

    {
        let mut children = state.children.lock().map_err(|e| e.to_string())?;
        children.insert(
            run_id.clone(),
            ManagedChild {
                child,
                node_id: node_id.clone(),
            },
        );
    }

    let _ = app.emit(
        "orchestrator://status",
        OrchestratorStatusEvent {
            run_id: run_id.clone(),
            node_id: node_id.clone(),
            status: "running".into(),
            message: Some("Headless smoke spawned".into()),
            exit_code: None,
            session_id: None,
            source: "heuristic".into(),
            at: now_iso(),
        },
    );

    let app_out = app.clone();
    let run_out = run_id.clone();
    let node_out = node_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = app_out.emit(
                "orchestrator://stdout",
                OrchestratorStdoutEvent {
                    run_id: run_out.clone(),
                    node_id: node_out.clone(),
                    stream: "stdout".into(),
                    line,
                    at: now_iso(),
                },
            );
        }
    });

    let app_err = app.clone();
    let run_err = run_id.clone();
    let node_err = node_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = app_err.emit(
                "orchestrator://stdout",
                OrchestratorStdoutEvent {
                    run_id: run_err.clone(),
                    node_id: node_err.clone(),
                    stream: "stderr".into(),
                    line,
                    at: now_iso(),
                },
            );
        }
    });

    let state_wait = Arc::clone(&state);
    let app_wait = app.clone();
    let run_wait = run_id.clone();
    let node_wait = node_id.clone();
    thread::spawn(move || {
        let exit_code = loop {
            thread::sleep(Duration::from_millis(120));
            let mut children = match state_wait.children.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let Some(managed) = children.get_mut(&run_wait) else {
                return;
            };
            match managed.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    children.remove(&run_wait);
                    break code;
                }
                Ok(None) => continue,
                Err(err) => {
                    children.remove(&run_wait);
                    let _ = app_wait.emit(
                        "orchestrator://status",
                        OrchestratorStatusEvent {
                            run_id: run_wait.clone(),
                            node_id: node_wait.clone(),
                            status: "failed".into(),
                            message: Some(format!("wait error: {err}")),
                            exit_code: None,
                            session_id: None,
                            source: "heuristic".into(),
                            at: now_iso(),
                        },
                    );
                    return;
                }
            }
        };

        let (status, message) = match exit_code {
            Some(0) => ("passed", Some("Cursor Agent smoke exited 0".to_string())),
            Some(code) => (
                "failed",
                Some(format!("Cursor Agent smoke exited with code {code}")),
            ),
            None => (
                "failed",
                Some("Cursor Agent smoke terminated without exit code".into()),
            ),
        };

        let _ = app_wait.emit(
            "orchestrator://status",
            OrchestratorStatusEvent {
                run_id: run_wait,
                node_id: node_wait,
                status: status.into(),
                message,
                exit_code,
                session_id: None,
                source: "heuristic".into(),
                at: now_iso(),
            },
        );
    });

    Ok(OrchestratorStartResult {
        run_id,
        node_id,
        pid: Some(pid),
        program: program.display().to_string(),
        display,
        cwd,
        mode: "smoke".into(),
        session_id: None,
    })
}

#[tauri::command]
pub fn stop_orchestrator_agent(
    app: AppHandle,
    state: State<'_, Arc<OrchestratorState>>,
    run_id: String,
) -> Result<(), String> {
    let mut children = state.children.lock().map_err(|e| e.to_string())?;
    let Some(mut managed) = children.remove(&run_id) else {
        return Err(format!("No running smoke process for run_id={run_id}"));
    };
    let node_id = managed.node_id.clone();
    let _ = managed.child.kill();
    let _ = managed.child.wait();

    let _ = app.emit(
        "orchestrator://status",
        OrchestratorStatusEvent {
            run_id,
            node_id,
            status: "failed".into(),
            message: Some("Smoke stopped by user".into()),
            exit_code: None,
            session_id: None,
            source: "adapter".into(),
            at: now_iso(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{resolve_agent_program, resolve_preferred_terminal, TerminalKind, workspace_chat_dir};
    use std::path::PathBuf;

    #[test]
    fn resolves_official_cursor_agent_cli() {
        let program = resolve_agent_program().expect("agent CLI must be on PATH for E2E");
        assert!(program.exists());
    }

    #[test]
    fn workspace_chat_hash_matches_known_graph_enj_bucket() {
        let cwd = PathBuf::from("/Users/hyungjuyu/Projects/AI/Graph_Enj");
        let dir = workspace_chat_dir(&cwd).expect("chat dir");
        assert!(dir
            .to_string_lossy()
            .ends_with("07f0ffb3c20def875c14e78f143646d8"));
    }

    #[test]
    fn preferred_terminal_is_not_hardcoded_to_apple_terminal_when_ghostty_present() {
        let term = resolve_preferred_terminal();
        if PathBuf::from("/Applications/Ghostty.app").is_dir() {
            assert_eq!(term.app_name, "Ghostty");
            assert_eq!(term.kind, TerminalKind::Ghostty);
        } else {
            assert!(!term.app_name.is_empty());
        }
    }
}
