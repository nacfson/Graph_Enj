mod process;

use process::{
    focus_orchestrator_terminal, open_orchestrator_session, probe_cursor_agent,
    start_orchestrator_smoke, stop_orchestrator_agent, OrchestratorState,
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct ClaudeProbe {
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlan {
    pub run_id: String,
    pub node_id: String,
    pub provider: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub display: String,
    pub dry_run: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecordDto {
    pub id: String,
    pub graph_id: String,
    pub graph_name: String,
    pub repo_path: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
fn get_workspace_root() -> Result<String, String> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let root = std::path::Path::new(manifest_dir)
        .parent()
        .ok_or_else(|| "Unable to resolve workspace root".to_string())?;
    Ok(root.display().to_string())
}

#[tauri::command]
fn probe_claude_cli() -> ClaudeProbe {
    match Command::new("claude").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let detail = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_string();
            ClaudeProbe {
                available: true,
                detail: if detail.is_empty() {
                    "claude found".into()
                } else {
                    detail
                },
            }
        }
        Ok(output) => ClaudeProbe {
            available: false,
            detail: format!(
                "claude exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        },
        Err(err) => ClaudeProbe {
            available: false,
            detail: format!("claude not found on PATH ({err})"),
        },
    }
}

#[tauri::command]
fn plan_claude_session(
    node_id: String,
    prompt: String,
    cwd: String,
    resume_session_id: Option<String>,
    permission: String,
) -> SessionPlan {
    let run_id = Uuid::new_v4().to_string();
    let mut args: Vec<String> = Vec::new();

    if let Some(session) = resume_session_id.filter(|s| !s.is_empty()) {
        args.push("-r".into());
        args.push(session);
    }

    args.push("-p".into());
    args.push(prompt);
    args.push("--output-format".into());
    args.push("json".into());

    match permission.as_str() {
        "read" => {
            args.push("--allowedTools".into());
            args.push("Read,Glob,Grep".into());
        }
        "write" => {
            args.push("--allowedTools".into());
            args.push("Read,Edit,Write,Bash,Glob,Grep".into());
        }
        _ => {}
    }

    let display = format!("claude {}", args.join(" "));

    SessionPlan {
        run_id,
        node_id,
        provider: "claude-code".into(),
        program: "claude".into(),
        args,
        cwd,
        display,
        dry_run: true,
    }
}

#[tauri::command]
fn save_run_record(app: tauri::AppHandle, record: RunRecordDto) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", record.id));
    let json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::new(OrchestratorState::default()))
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            probe_claude_cli,
            probe_cursor_agent,
            plan_claude_session,
            save_run_record,
            open_orchestrator_session,
            focus_orchestrator_terminal,
            start_orchestrator_smoke,
            stop_orchestrator_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
