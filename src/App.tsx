import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { GraphCanvas } from "./components/GraphCanvas";
import { NodeInspector } from "./components/NodeInspector";
import { RunPanel } from "./components/RunPanel";
import { useAppStore } from "./store/appStore";
import type { CursorProbe } from "./adapters/cursorAgent";
import "./App.css";

export default function App() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const resetTemplate = useAppStore((s) => s.resetTemplate);
  const graph = useAppStore((s) => s.graph);
  const [cursorStatus, setCursorStatus] = useState<string>("…");
  const [repoPath, setRepoPath] = useState<string>("");
  const inTauri = isTauri();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) {
        if (!cancelled) {
          setCursorStatus(
            "browser preview — open Graph_Enj desktop app to spawn agents",
          );
          setRepoPath("(use tauri window)");
        }
        return;
      }
      try {
        const root = await invoke<string>("get_workspace_root");
        if (!cancelled) {
          setRepoPath(root);
          resetTemplate(root);
        }
      } catch {
        if (!cancelled) {
          setRepoPath("(workspace root unavailable)");
        }
      }
      try {
        const probe = await invoke<CursorProbe>("probe_cursor_agent");
        if (!cancelled) {
          if (!probe.available) {
            setCursorStatus(probe.detail);
          } else if (!probe.authenticated) {
            setCursorStatus(
              `cursor agent found, not logged in — ${probe.detail}`,
            );
          } else {
            setCursorStatus(`cursor ok — ${probe.detail}`);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setCursorStatus(
            err instanceof Error ? err.message : "cursor probe failed",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resetTemplate]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand">Graph_Enj</div>
          <div className="brand-sub">
            Local coding-agent graph studio · session control plane
          </div>
        </div>
        <div className="topbar-actions">
          <div className="mode-toggle">
            <button
              type="button"
              className={mode === "studio" ? "active" : ""}
              onClick={() => setMode("studio")}
            >
              Studio
            </button>
            <button
              type="button"
              className={mode === "monitor" ? "active" : ""}
              onClick={() => setMode("monitor")}
            >
              Monitor
            </button>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => resetTemplate(repoPath)}
          >
            Reset template
          </button>
        </div>
      </header>

      {!inTauri ? (
        <div className="banner-warn">
          You are in a browser preview. Live Cursor Agent spawn only works in
          the native Graph_Enj window from <code>npm run tauri dev</code>.
        </div>
      ) : null}

      <div className="status-strip">
        <span>
          <strong>{graph.name}</strong> v{graph.version}
        </span>
        <span className="muted">repo: {graph.repoPath || repoPath || "—"}</span>
        <span className="muted">{cursorStatus}</span>
      </div>

      <main className="main-grid">
        <GraphCanvas />
        <div className="right-rail">
          <NodeInspector />
          <RunPanel />
        </div>
      </main>
    </div>
  );
}
