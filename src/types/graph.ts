/** Graph_Enj — graph definition is the source of truth. */

export type ProviderId = "claude-code" | "codex" | "cursor" | "shell" | "human";

export type NodeRole =
  | "orchestrator"
  | "planner"
  | "implementer"
  | "evaluator"
  | "verifier"
  | "repair"
  | "gate"
  | "router"
  | "human"
  | "finalize"
  | "worker";

export type EdgeKind = "normal" | "parallel" | "feedback" | "human";

export type NodeRuntimeStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_human"
  | "passed"
  | "failed"
  | "skipped";

export interface AgentBinding {
  provider: ProviderId;
  /** Optional existing CLI session id to resume (e.g. Claude Code session). */
  sessionId?: string;
  /** If true, this node may spawn child sessions for downstream workers. */
  canSpawn: boolean;
  /** Permission hint shown in UI and passed into adapter prompts. */
  permission: "read" | "write" | "none" | "decision";
}

export type GraphNodeData = {
  label: string;
  role: NodeRole;
  description: string;
  binding: AgentBinding;
  status: NodeRuntimeStatus;
} & Record<string, unknown>;

export type GraphEdgeData = {
  kind: EdgeKind;
  label?: string;
} & Record<string, unknown>;

export interface GraphDefinition {
  id: string;
  name: string;
  version: number;
  description: string;
  /** Repo the graph runs against (absolute path). */
  repoPath: string;
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    data: GraphNodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    data: GraphEdgeData;
  }>;
}

/** Structured status event adapters should emit (preferred observation path). */
export interface StatusEvent {
  runId: string;
  nodeId: string;
  status: NodeRuntimeStatus;
  message?: string;
  sessionId?: string;
  at: string;
  source: "adapter" | "heuristic";
}

export interface RunRecord {
  id: string;
  graphId: string;
  graphName: string;
  repoPath: string;
  status: "running" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  /** nodeId -> session id */
  sessions: Record<string, string>;
  /** Recommended restart target when a node fails */
  failedSubgraphRoot?: string;
  events: StatusEvent[];
}
