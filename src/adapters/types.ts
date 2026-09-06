import type { AgentBinding, GraphNodeData, ProviderId } from "../types/graph";

export interface AdapterInvokeInput {
  runId: string;
  nodeId: string;
  role: GraphNodeData["role"];
  binding: AgentBinding;
  repoPath: string;
  prompt: string;
  /** When set, resume this CLI session instead of creating a new one. */
  resumeSessionId?: string;
}

export interface AdapterCommandPlan {
  provider: ProviderId;
  /** Executable argv[0] */
  program: string;
  args: string[];
  cwd: string;
  /** Human-readable command for UI / dry-run */
  display: string;
  /** Suggested session id handle (may be filled after spawn) */
  plannedSessionHint?: string;
}

export interface AdapterResult {
  ok: boolean;
  sessionId?: string;
  stdout?: string;
  stderr?: string;
  dryRun: boolean;
  command: AdapterCommandPlan;
}

export interface AgentAdapter {
  provider: ProviderId;
  buildCommand(input: AdapterInvokeInput): AdapterCommandPlan;
}
