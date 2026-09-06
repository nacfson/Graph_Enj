import { claudeCodeAdapter } from "./claudeCode";
import type { AdapterInvokeInput, AdapterCommandPlan, AgentAdapter } from "./types";
import type { ProviderId } from "../types/graph";

const codexAdapter: AgentAdapter = {
  provider: "codex",
  buildCommand(input: AdapterInvokeInput): AdapterCommandPlan {
    const args = ["exec", input.prompt];
    return {
      provider: "codex",
      program: "codex",
      args,
      cwd: input.repoPath,
      display: `codex exec ${JSON.stringify(input.prompt)}`,
      plannedSessionHint: input.resumeSessionId ?? input.binding.sessionId,
    };
  },
};

const cursorAdapter: AgentAdapter = {
  provider: "cursor",
  buildCommand(input: AdapterInvokeInput): AdapterCommandPlan {
    const args = [
      "-p",
      "--mode=ask",
      "--output-format",
      "stream-json",
      input.prompt,
    ];
    return {
      provider: "cursor",
      program: "agent",
      args,
      cwd: input.repoPath,
      display: `agent ${args.map((a) => JSON.stringify(a)).join(" ")}`,
      plannedSessionHint: input.resumeSessionId ?? input.binding.sessionId,
    };
  },
};

const shellAdapter: AgentAdapter = {
  provider: "shell",
  buildCommand(input: AdapterInvokeInput): AdapterCommandPlan {
    const args = ["-lc", input.prompt];
    return {
      provider: "shell",
      program: "zsh",
      args,
      cwd: input.repoPath,
      display: `zsh -lc ${JSON.stringify(input.prompt)}`,
    };
  },
};

const adapters: Record<Exclude<ProviderId, "human">, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  shell: shellAdapter,
};

export function getAdapter(provider: ProviderId): AgentAdapter | null {
  if (provider === "human") return null;
  return adapters[provider];
}

export function buildNodeCommand(input: AdapterInvokeInput): AdapterCommandPlan | null {
  const adapter = getAdapter(input.binding.provider);
  if (!adapter) return null;
  return adapter.buildCommand(input);
}

export { claudeCodeAdapter, statusEventHint } from "./claudeCode";
