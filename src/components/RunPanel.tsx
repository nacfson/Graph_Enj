import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import {
  tryParseGraphEnjStatus,
  type OrchestratorStatusEvent,
  type OrchestratorStdoutEvent,
} from "../adapters/cursorAgent";
import type { NodeRuntimeStatus } from "../types/graph";

const STATUS_SET = new Set<NodeRuntimeStatus>([
  "idle",
  "queued",
  "running",
  "waiting_human",
  "passed",
  "failed",
  "skipped",
]);

function asRuntimeStatus(value: string): NodeRuntimeStatus | null {
  return STATUS_SET.has(value as NodeRuntimeStatus)
    ? (value as NodeRuntimeStatus)
    : null;
}

export function RunPanel() {
  const prompt = useAppStore((s) => s.prompt);
  const setPrompt = useAppStore((s) => s.setPrompt);
  const startDryRun = useAppStore((s) => s.startDryRun);
  const openOrchestratorSession = useAppStore((s) => s.openOrchestratorSession);
  const focusOrchestratorTerminal = useAppStore(
    (s) => s.focusOrchestratorTerminal,
  );
  const markOrchestratorComplete = useAppStore((s) => s.markOrchestratorComplete);
  const detachOrchestratorSession = useAppStore(
    (s) => s.detachOrchestratorSession,
  );
  const startOrchestratorSmoke = useAppStore((s) => s.startOrchestratorSmoke);
  const stopOrchestratorSmoke = useAppStore((s) => s.stopOrchestratorSmoke);
  const bindOrchestratorSession = useAppStore((s) => s.bindOrchestratorSession);
  const activeRun = useAppStore((s) => s.activeRun);
  const lastCommandPreview = useAppStore((s) => s.lastCommandPreview);
  const liveLog = useAppStore((s) => s.liveLog);
  const livePid = useAppStore((s) => s.livePid);
  const liveError = useAppStore((s) => s.liveError);
  const boundSessionId = useAppStore((s) => s.boundSessionId);
  const orchestratorMode = useAppStore((s) => s.orchestratorMode);
  const appendLiveLog = useAppStore((s) => s.appendLiveLog);
  const applyStatusEvent = useAppStore((s) => s.applyStatusEvent);
  const humanDecide = useAppStore((s) => s.humanDecide);
  const restartFailedSubgraph = useAppStore((s) => s.restartFailedSubgraph);
  const recommendRestart = useAppStore((s) => s.recommendRestart);

  useEffect(() => {
    let unlistenStdout: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        unlistenStdout = await listen<OrchestratorStdoutEvent>(
          "orchestrator://stdout",
          (event) => {
            const payload = event.payload;
            appendLiveLog(`[${payload.stream}] ${payload.line}`);
            const parsed = tryParseGraphEnjStatus(payload.line);
            if (parsed) {
              const status = asRuntimeStatus(parsed.status);
              if (status) {
                applyStatusEvent({
                  runId: payload.runId,
                  nodeId: parsed.nodeId,
                  status,
                  message: parsed.message,
                  at: new Date().toISOString(),
                  source: "adapter",
                });
              }
            }
          },
        );
        unlistenStatus = await listen<OrchestratorStatusEvent>(
          "orchestrator://status",
          (event) => {
            const payload = event.payload;
            if (payload.sessionId) {
              bindOrchestratorSession(payload.sessionId);
            }
            const status = asRuntimeStatus(payload.status);
            if (!status) return;
            applyStatusEvent({
              runId: payload.runId,
              nodeId: payload.nodeId,
              status,
              message: payload.message ?? undefined,
              sessionId: payload.sessionId ?? undefined,
              at: new Date().toISOString(),
              source: payload.source === "adapter" ? "adapter" : "heuristic",
            });
            if (payload.message) {
              appendLiveLog(`[status] ${payload.status}: ${payload.message}`);
            }
          },
        );
      } catch {
        // Outside Tauri — live events unavailable.
      }
    })();

    return () => {
      cancelled = true;
      void cancelled;
      unlistenStdout?.();
      unlistenStatus?.();
    };
  }, [appendLiveLog, applyStatusEvent, bindOrchestratorSession]);

  const interactiveActive =
    orchestratorMode === "interactive" && activeRun?.status === "running";
  const smokeActive =
    orchestratorMode === "smoke" && activeRun?.status === "running";

  return (
    <aside className="side-panel run-panel">
      <div className="panel-kicker">Run</div>
      <h2>Orchestrator session</h2>
      <p className="muted">
        Opens a real interactive Cursor Agent in your preferred terminal
        (Ghostty, iTerm, kitty, etc. — not hardcoded to Terminal.app). Prompt
        there — Graph_Enj binds the session and shows status.
      </p>

      <section className="panel-section">
        <div className="btn-row">
          <button
            className="btn primary"
            type="button"
            onClick={() => void openOrchestratorSession()}
            disabled={interactiveActive || smokeActive}
          >
            Open orchestrator session (Terminal)
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void focusOrchestratorTerminal()}
            disabled={!interactiveActive && !boundSessionId}
          >
            Focus Terminal
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="btn"
            type="button"
            onClick={markOrchestratorComplete}
            disabled={!interactiveActive && !boundSessionId}
          >
            Mark complete
          </button>
          <button
            className="btn"
            type="button"
            onClick={detachOrchestratorSession}
            disabled={!interactiveActive && !boundSessionId}
          >
            Detach
          </button>
        </div>
      </section>

      {liveError ? (
        <section className="panel-section">
          <div className="panel-label">Error</div>
          <p className="muted" style={{ color: "#b91c1c" }}>
            {liveError}
          </p>
        </section>
      ) : null}

      {boundSessionId ? (
        <section className="panel-section">
          <div className="panel-label">Bound session</div>
          <code>{boundSessionId}</code>
        </section>
      ) : null}

      {livePid != null ? (
        <section className="panel-section">
          <div className="panel-label">Smoke PID</div>
          <div>
            <code>{livePid}</code>
          </div>
        </section>
      ) : null}

      {lastCommandPreview ? (
        <section className="panel-section">
          <div className="panel-label">Command</div>
          <pre className="code-block">{lastCommandPreview}</pre>
        </section>
      ) : null}

      {liveLog.length > 0 ? (
        <section className="panel-section">
          <div className="panel-label">Live log</div>
          <pre className="code-block live-log">
            {liveLog.slice(-80).join("\n")}
          </pre>
        </section>
      ) : null}

      <section className="panel-section">
        <div className="panel-label">Notes (non-authoritative)</div>
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Not sent to Cursor Agent — prompt in Terminal."
        />
      </section>

      <section className="panel-section">
        <div className="panel-label">Dev</div>
        <div className="btn-row">
          <button className="btn" type="button" onClick={startDryRun}>
            Dry-run (sim)
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void startOrchestratorSmoke()}
            disabled={smokeActive || interactiveActive}
          >
            Smoke (headless)
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void stopOrchestratorSmoke()}
            disabled={!smokeActive}
          >
            Stop smoke
          </button>
        </div>
      </section>

      {activeRun ? (
        <>
          <section className="panel-section">
            <div className="panel-label">Active run</div>
            <div className="run-meta">
              <div>
                <strong>{activeRun.graphName}</strong>
              </div>
              <div className="muted">id: {activeRun.id.slice(0, 8)}</div>
              <div className="muted">mode: {orchestratorMode}</div>
              <div className={`status-chip status-${activeRun.status}`}>
                {activeRun.status}
              </div>
            </div>
          </section>

          {activeRun.status === "paused" ? (
            <section className="panel-section actions">
              <div className="panel-label">Human gate</div>
              <div className="btn-row">
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => humanDecide("approve")}
                >
                  Approve
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => humanDecide("reject")}
                >
                  Reject
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => humanDecide("redelegate")}
                >
                  Redelegate
                </button>
              </div>
            </section>
          ) : null}

          <section className="panel-section">
            <div className="panel-label">Restart (sim / later)</div>
            <p className="muted">
              Recommended: failed-subgraph → <code>{recommendRestart()}</code>
            </p>
            <button
              className="btn"
              type="button"
              onClick={restartFailedSubgraph}
            >
              Restart failed subgraph
            </button>
          </section>

          <section className="panel-section">
            <div className="panel-label">Event log</div>
            <div className="event-log">
              {activeRun.events
                .slice()
                .reverse()
                .map((ev, i) => (
                  <div key={`${ev.at}-${i}`} className="event-row">
                    <span className={`pill source-${ev.source}`}>
                      {ev.source}
                    </span>
                    <span className="event-node">{ev.nodeId}</span>
                    <span className={`status-chip status-${ev.status}`}>
                      {ev.status}
                    </span>
                    {ev.message ? (
                      <span className="muted">{ev.message}</span>
                    ) : null}
                  </div>
                ))}
            </div>
          </section>
        </>
      ) : null}
    </aside>
  );
}
