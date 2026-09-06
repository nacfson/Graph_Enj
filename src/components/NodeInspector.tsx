import { useAppStore } from "../store/appStore";
import type { ProviderId } from "../types/graph";

const providers: ProviderId[] = [
  "claude-code",
  "codex",
  "cursor",
  "shell",
  "human",
];

export function NodeInspector() {
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const nodes = useAppStore((s) => s.nodes);
  const mode = useAppStore((s) => s.mode);
  const updateSelectedBinding = useAppStore((s) => s.updateSelectedBinding);

  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node) {
    return (
      <aside className="side-panel">
        <div className="panel-kicker">Inspector</div>
        <h2>Select a node</h2>
        <p className="muted">
          The React Flow graph is the source of truth. Bind providers and mark
          which node may spawn workers.
        </p>
      </aside>
    );
  }

  const { data } = node;
  const editable = mode === "studio";

  return (
    <aside className="side-panel">
      <div className="panel-kicker">Inspector</div>
      <h2>{data.label}</h2>
      <p className="muted">{data.description}</p>

      <section className="panel-section">
        <div className="panel-label">Role</div>
        <div>{data.role}</div>
      </section>

      <section className="panel-section">
        <div className="panel-label">Provider</div>
        <select
          disabled={!editable || data.role === "human"}
          value={data.binding.provider}
          onChange={(e) =>
            updateSelectedBinding({ provider: e.target.value as ProviderId })
          }
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </section>

      <section className="panel-section">
        <div className="panel-label">Session id (optional resume)</div>
        <input
          disabled={!editable}
          placeholder="e.g. 123979fh2nk"
          value={data.binding.sessionId ?? ""}
          onChange={(e) =>
            updateSelectedBinding({
              sessionId: e.target.value.trim() || undefined,
            })
          }
        />
      </section>

      <section className="panel-section">
        <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!editable}
            checked={data.binding.canSpawn}
            onChange={(e) =>
              updateSelectedBinding({ canSpawn: e.target.checked })
            }
          />
          Can spawn workers (appointed by graph)
        </label>
      </section>

      <section className="panel-section">
        <div className="panel-label">Permission</div>
        <select
          disabled={!editable}
          value={data.binding.permission}
          onChange={(e) =>
            updateSelectedBinding({
              permission: e.target.value as typeof data.binding.permission,
            })
          }
        >
          <option value="none">none</option>
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="decision">decision</option>
        </select>
      </section>

      <section className="panel-section">
        <div className="panel-label">Runtime status</div>
        <div className={`status-chip status-${data.status}`}>{data.status}</div>
      </section>
    </aside>
  );
}
