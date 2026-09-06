import type { GraphDefinition } from "../types/graph";

/** Reference coding graph — React Flow source of truth for first demo. */
export const CODING_TEMPLATE: GraphDefinition = {
  id: "coding-reference-v1",
  name: "Multi-Agent Coding Graph",
  version: 1,
  description:
    "Planner → implement → tests → evaluate → risk → human → finalize, with repair feedback.",
  repoPath: "",
  nodes: [
    {
      id: "orchestrator",
      position: { x: 420, y: 0 },
      data: {
        label: "Graph Orchestrator",
        role: "orchestrator",
        description: "Session-bound manager; spawner appointed by graph.",
        binding: {
          provider: "cursor",
          canSpawn: true,
          permission: "none",
        },
        status: "idle",
      },
    },
    {
      id: "planner",
      position: { x: 420, y: 120 },
      data: {
        label: "Planner",
        role: "planner",
        description: "Decompose work + acceptance criteria",
        binding: {
          provider: "claude-code",
          canSpawn: false,
          permission: "read",
        },
        status: "idle",
      },
    },
    {
      id: "implement",
      position: { x: 120, y: 260 },
      data: {
        label: "Codex — Implement",
        role: "implementer",
        description: "Primary code-writing worker",
        binding: {
          provider: "codex",
          canSpawn: false,
          permission: "write",
        },
        status: "idle",
      },
    },
    {
      id: "research",
      position: { x: 420, y: 260 },
      data: {
        label: "Research Worker",
        role: "worker",
        description: "Optional evidence / dependency analysis",
        binding: {
          provider: "claude-code",
          canSpawn: false,
          permission: "read",
        },
        status: "idle",
      },
    },
    {
      id: "parallel",
      position: { x: 720, y: 260 },
      data: {
        label: "Parallel Worker",
        role: "worker",
        description: "Optional independent implementation slice",
        binding: {
          provider: "cursor",
          canSpawn: false,
          permission: "write",
        },
        status: "idle",
      },
    },
    {
      id: "gate",
      position: { x: 120, y: 400 },
      data: {
        label: "Tests / Lint / Build",
        role: "gate",
        description: "Deterministic ground truth",
        binding: {
          provider: "shell",
          canSpawn: false,
          permission: "read",
        },
        status: "idle",
      },
    },
    {
      id: "evaluate",
      position: { x: 420, y: 400 },
      data: {
        label: "Claude — Evaluate",
        role: "evaluator",
        description: "Independent reviewer",
        binding: {
          provider: "claude-code",
          canSpawn: false,
          permission: "read",
        },
        status: "idle",
      },
    },
    {
      id: "risk",
      position: { x: 720, y: 400 },
      data: {
        label: "Risk Router",
        role: "router",
        description: "Escalate high-risk changes only",
        binding: {
          provider: "shell",
          canSpawn: false,
          permission: "none",
        },
        status: "idle",
      },
    },
    {
      id: "repair",
      position: { x: 120, y: 540 },
      data: {
        label: "Codex — Repair",
        role: "repair",
        description: "Targeted repair from evidence",
        binding: {
          provider: "codex",
          canSpawn: false,
          permission: "write",
        },
        status: "idle",
      },
    },
    {
      id: "verify",
      position: { x: 720, y: 540 },
      data: {
        label: "Cursor — Verify",
        role: "verifier",
        description: "Conditional high-risk second opinion",
        binding: {
          provider: "cursor",
          canSpawn: false,
          permission: "read",
        },
        status: "idle",
      },
    },
    {
      id: "human",
      position: { x: 420, y: 560 },
      data: {
        label: "Human Approval",
        role: "human",
        description: "Pause · inspect · approve / reject / restart",
        binding: {
          provider: "human",
          canSpawn: false,
          permission: "decision",
        },
        status: "idle",
      },
    },
    {
      id: "finalize",
      position: { x: 420, y: 680 },
      data: {
        label: "Merge / Finalize",
        role: "finalize",
        description: "Deterministic post-approval action",
        binding: {
          provider: "shell",
          canSpawn: false,
          permission: "write",
        },
        status: "idle",
      },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "orchestrator",
      target: "planner",
      data: { kind: "normal" },
    },
    {
      id: "e2",
      source: "planner",
      target: "implement",
      data: { kind: "parallel", label: "delegate" },
    },
    {
      id: "e3",
      source: "planner",
      target: "research",
      data: { kind: "parallel", label: "delegate" },
    },
    {
      id: "e4",
      source: "planner",
      target: "parallel",
      data: { kind: "parallel", label: "delegate" },
    },
    {
      id: "e5",
      source: "implement",
      target: "gate",
      data: { kind: "normal" },
    },
    {
      id: "e6",
      source: "research",
      target: "evaluate",
      data: { kind: "normal" },
    },
    {
      id: "e7",
      source: "parallel",
      target: "risk",
      data: { kind: "normal" },
    },
    {
      id: "e8",
      source: "gate",
      target: "evaluate",
      data: { kind: "normal", label: "PASS" },
    },
    {
      id: "e9",
      source: "gate",
      target: "repair",
      data: { kind: "feedback", label: "FAIL" },
    },
    {
      id: "e10",
      source: "repair",
      target: "gate",
      data: { kind: "feedback", label: "retry ≤ N" },
    },
    {
      id: "e11",
      source: "evaluate",
      target: "risk",
      data: { kind: "normal", label: "PASS" },
    },
    {
      id: "e12",
      source: "evaluate",
      target: "repair",
      data: { kind: "feedback", label: "REJECT" },
    },
    {
      id: "e13",
      source: "risk",
      target: "verify",
      data: { kind: "normal", label: "HIGH RISK" },
    },
    {
      id: "e14",
      source: "risk",
      target: "human",
      data: { kind: "human", label: "LOW / NORMAL" },
    },
    {
      id: "e15",
      source: "verify",
      target: "human",
      data: { kind: "human" },
    },
    {
      id: "e16",
      source: "human",
      target: "repair",
      data: { kind: "feedback", label: "REDELEGATE" },
    },
    {
      id: "e17",
      source: "human",
      target: "finalize",
      data: { kind: "human" },
    },
  ],
};
