export const ORCHESTRATOR_SMOKE_PROMPT =
  "Reply with one short sentence confirming Graph_Enj can reach Cursor Agent. Do not modify any files.";

export interface OrchestratorStartResult {
  runId: string;
  nodeId: string;
  pid?: number | null;
  program: string;
  display: string;
  cwd: string;
  mode: string;
  sessionId?: string | null;
}

export interface OrchestratorStdoutEvent {
  runId: string;
  nodeId: string;
  stream: string;
  line: string;
  at: string;
}

export interface OrchestratorStatusEvent {
  runId: string;
  nodeId: string;
  status: string;
  message?: string | null;
  exitCode?: number | null;
  sessionId?: string | null;
  source: string;
  at: string;
}

export interface CursorProbe {
  available: boolean;
  authenticated: boolean;
  program?: string | null;
  detail: string;
}

/** Prefer structured Graph_Enj status lines when the agent emits them. */
export function tryParseGraphEnjStatus(
  line: string,
): { nodeId: string; status: string; message?: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("graph_enj")) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      graph_enj?: boolean;
      nodeId?: string;
      status?: string;
      message?: string;
    };
    if (!parsed.graph_enj || !parsed.nodeId || !parsed.status) return null;
    return {
      nodeId: parsed.nodeId,
      status: parsed.status,
      message: parsed.message,
    };
  } catch {
    return null;
  }
}
