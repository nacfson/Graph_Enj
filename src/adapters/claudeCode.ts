import type { AdapterInvokeInput, AdapterCommandPlan, AgentAdapter } from "./types";

/**
 * Claude Code subscription CLI adapter (not API-key based).
 * Headless print mode: `claude -p` / resume with `claude -r <session> -p`.
 */
export const claudeCodeAdapter: AgentAdapter = {
  provider: "claude-code",

  buildCommand(input: AdapterInvokeInput): AdapterCommandPlan {
    const args: string[] = [];
    const resume = input.resumeSessionId ?? input.binding.sessionId;

    if (resume) {
      args.push("-r", resume);
    }

    args.push("-p", input.prompt);
    args.push("--output-format", "json");

    // Prefer explicit tool allowlist so headless runs do not hang on prompts.
    if (input.binding.permission === "read") {
      args.push("--allowedTools", "Read,Glob,Grep");
    } else if (input.binding.permission === "write") {
      args.push("--allowedTools", "Read,Edit,Write,Bash,Glob,Grep");
    }

    const display = ["claude", ...args.map(shellQuote)].join(" ");

    return {
      provider: "claude-code",
      program: "claude",
      args,
      cwd: input.repoPath,
      display,
      plannedSessionHint: resume,
    };
  },
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Status event payload adapters should print for Graph_Enj observation path B. */
export function statusEventHint(runId: string, nodeId: string): string {
  return [
    "When you start and finish work, emit a single JSON line on stdout:",
    `{"graph_enj":true,"runId":"${runId}","nodeId":"${nodeId}","status":"running|passed|failed","message":"..."}`,
  ].join("\n");
}
