import type { CSSProperties } from "react";
import { create } from "zustand";
import { v4 as uuid } from "uuid";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Edge, Node } from "@xyflow/react";
import { CODING_TEMPLATE } from "../data/templateGraph";
import { buildNodeCommand } from "../adapters";
import { statusEventHint } from "../adapters/claudeCode";
import { ORCHESTRATOR_SMOKE_PROMPT } from "../adapters/cursorAgent";
import type {
  GraphDefinition,
  GraphEdgeData,
  GraphNodeData,
  RunRecord,
  StatusEvent,
} from "../types/graph";

export type AppMode = "studio" | "monitor";

type RFNode = Node<GraphNodeData>;
type RFEdge = Edge<GraphEdgeData>;

function toFlow(graph: GraphDefinition): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "agent",
      position: n.position,
      data: { ...n.data },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.data.label,
      data: { ...e.data },
      animated: e.data.kind === "parallel",
      style: edgeStyle(e.data.kind),
    })),
  };
}

function edgeStyle(kind: GraphEdgeData["kind"]): CSSProperties {
  switch (kind) {
    case "feedback":
      return { stroke: "#c2410c", strokeDasharray: "6 4" };
    case "human":
      return { stroke: "#6d28d9" };
    case "parallel":
      return { stroke: "#2563eb" };
    default:
      return { stroke: "#64748b" };
  }
}

function fromFlow(
  base: GraphDefinition,
  nodes: RFNode[],
  edges: RFEdge[],
): GraphDefinition {
  return {
    ...base,
    nodes: nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: n.data,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data ?? { kind: "normal" },
    })),
  };
}

interface AppState {
  mode: AppMode;
  graph: GraphDefinition;
  nodes: RFNode[];
  edges: RFEdge[];
  selectedNodeId: string | null;
  prompt: string;
  activeRun: RunRecord | null;
  lastCommandPreview: string | null;
  liveLog: string[];
  livePid: number | null;
  liveError: string | null;
  boundSessionId: string | null;
  orchestratorMode: "idle" | "interactive" | "smoke";
  setMode: (mode: AppMode) => void;
  setPrompt: (prompt: string) => void;
  setNodes: (nodes: RFNode[]) => void;
  setEdges: (edges: RFEdge[]) => void;
  selectNode: (id: string | null) => void;
  updateSelectedBinding: (patch: Partial<GraphNodeData["binding"]>) => void;
  resetTemplate: (repoPath: string) => void;
  applyStatusEvent: (event: StatusEvent) => void;
  appendLiveLog: (line: string) => void;
  bindOrchestratorSession: (sessionId: string) => void;
  startDryRun: () => void;
  openOrchestratorSession: () => Promise<void>;
  focusOrchestratorTerminal: () => Promise<void>;
  markOrchestratorComplete: () => void;
  detachOrchestratorSession: () => void;
  startOrchestratorSmoke: () => Promise<void>;
  stopOrchestratorSmoke: () => Promise<void>;
  recommendRestart: () => string | null;
  restartFailedSubgraph: () => void;
  humanDecide: (decision: "approve" | "reject" | "redelegate") => void;
}

const initial = toFlow(CODING_TEMPLATE);

function formatInvokeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: "studio",
  graph: CODING_TEMPLATE,
  nodes: initial.nodes,
  edges: initial.edges,
  selectedNodeId: "orchestrator",
  prompt: "Scaffold Graph_Enj MVP: verify Tauri + React Flow graph studio boots.",
  activeRun: null,
  lastCommandPreview: null,
  liveLog: [],
  livePid: null,
  liveError: null,
  boundSessionId: null,
  orchestratorMode: "idle",

  setMode: (mode) => set({ mode }),
  setPrompt: (prompt) => set({ prompt }),
  appendLiveLog: (line) =>
    set((s) => ({ liveLog: [...s.liveLog.slice(-400), line] })),
  setNodes: (nodes) => {
    const { graph, edges } = get();
    set({ nodes, graph: fromFlow(graph, nodes, edges) });
  },
  setEdges: (edges) => {
    const { graph, nodes } = get();
    set({ edges, graph: fromFlow(graph, nodes, edges) });
  },
  selectNode: (id) => set({ selectedNodeId: id }),

  updateSelectedBinding: (patch) => {
    const { selectedNodeId, nodes, edges, graph } = get();
    if (!selectedNodeId) return;
    const next = nodes.map((n) =>
      n.id === selectedNodeId
        ? {
            ...n,
            data: {
              ...n.data,
              binding: { ...n.data.binding, ...patch },
            },
          }
        : n,
    );
    set({ nodes: next, graph: fromFlow(graph, next, edges) });
  },

  resetTemplate: (repoPath) => {
    const graph = { ...CODING_TEMPLATE, repoPath };
    const flow = toFlow(graph);
    set({
      graph,
      nodes: flow.nodes,
      edges: flow.edges,
      selectedNodeId: "orchestrator",
      activeRun: null,
      lastCommandPreview: null,
      liveLog: [],
      livePid: null,
      liveError: null,
      boundSessionId: null,
      orchestratorMode: "idle",
    });
  },

  bindOrchestratorSession: (sessionId) => {
    const { nodes, edges, graph, activeRun, applyStatusEvent } = get();
    const next = nodes.map((n) =>
      n.data.role === "orchestrator"
        ? {
            ...n,
            data: {
              ...n.data,
              binding: { ...n.data.binding, sessionId },
              status: "running" as const,
            },
          }
        : n,
    );
    set({
      nodes: next,
      graph: fromFlow(graph, next, edges),
      boundSessionId: sessionId,
      activeRun: activeRun
        ? {
            ...activeRun,
            sessions: { ...activeRun.sessions, orchestrator: sessionId },
            updatedAt: new Date().toISOString(),
          }
        : activeRun,
    });
    if (activeRun) {
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "orchestrator",
        status: "running",
        message: `session ${sessionId}`,
        sessionId,
        at: new Date().toISOString(),
        source: "adapter",
      });
    }
  },

  applyStatusEvent: (event) => {
    const { nodes, edges, graph, activeRun } = get();
    const nextNodes = nodes.map((n) => {
      if (n.id !== event.nodeId) return n;
      return {
        ...n,
        data: {
          ...n.data,
          status: event.status,
          binding: event.sessionId
            ? { ...n.data.binding, sessionId: event.sessionId }
            : n.data.binding,
        },
      };
    });
    let runStatus = activeRun?.status;
    if (activeRun) {
      if (event.status === "waiting_human") runStatus = "paused";
      else if (event.status === "passed" && event.nodeId === "orchestrator")
        runStatus = "completed";
      else if (event.status === "failed" && event.nodeId === "orchestrator")
        runStatus = "failed";
      else if (event.status === "running") runStatus = "running";
      else if (event.status === "idle" && event.nodeId === "orchestrator")
        runStatus = "completed";
    }
    const nextRun = activeRun
      ? {
          ...activeRun,
          updatedAt: event.at,
          events: [...activeRun.events, event],
          sessions: event.sessionId
            ? { ...activeRun.sessions, [event.nodeId]: event.sessionId }
            : activeRun.sessions,
          failedSubgraphRoot:
            event.status === "failed" ? event.nodeId : activeRun.failedSubgraphRoot,
          status: runStatus ?? activeRun.status,
        }
      : null;
    set({
      nodes: nextNodes,
      graph: fromFlow(graph, nextNodes, edges),
      activeRun: nextRun,
      boundSessionId: event.sessionId ?? get().boundSessionId,
      livePid:
        event.status === "passed" ||
        event.status === "failed" ||
        event.status === "idle"
          ? null
          : get().livePid,
      orchestratorMode:
        event.status === "idle" ||
        event.status === "passed" ||
        event.status === "failed"
          ? "idle"
          : get().orchestratorMode,
    });
  },

  openOrchestratorSession: async () => {
    const { graph, nodes, applyStatusEvent, appendLiveLog } = get();
    const orchestrator = nodes.find((n) => n.data.role === "orchestrator");
    if (!orchestrator) {
      set({ liveError: "No orchestrator node in graph" });
      return;
    }
    if (orchestrator.data.binding.provider !== "cursor") {
      set({
        liveError:
          "Orchestrator provider must be `cursor`. Set it in the inspector.",
      });
      return;
    }
    if (!isTauri()) {
      set({
        liveError:
          "Open session only works in the Graph_Enj desktop window (npm run tauri dev).",
      });
      return;
    }

    const now = new Date().toISOString();
    const cwd = graph.repoPath || ".";

    set({
      mode: "monitor",
      liveError: null,
      liveLog: [],
      livePid: null,
      boundSessionId: null,
      orchestratorMode: "interactive",
      lastCommandPreview: null,
      nodes: nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          status: n.id === orchestrator.id ? ("queued" as const) : ("idle" as const),
        },
      })),
      activeRun: {
        id: "pending",
        graphId: graph.id,
        graphName: graph.name,
        repoPath: cwd,
        status: "running",
        createdAt: now,
        updatedAt: now,
        sessions: {},
        events: [],
      },
    });

    try {
      const result = await invoke<{
        runId: string;
        nodeId: string;
        pid?: number | null;
        program: string;
        display: string;
        cwd: string;
        mode: string;
      }>("open_orchestrator_session", {
        nodeId: orchestrator.id,
        cwd,
      });

      set((s) => ({
        lastCommandPreview: result.display,
        activeRun: s.activeRun
          ? { ...s.activeRun, id: result.runId, updatedAt: new Date().toISOString() }
          : s.activeRun,
      }));
      appendLiveLog(result.display);
      appendLiveLog("waiting for Cursor Agent session id…");
      applyStatusEvent({
        runId: result.runId,
        nodeId: orchestrator.id,
        status: "running",
        message: "Terminal session opened — prompt in your preferred terminal",
        at: new Date().toISOString(),
        source: "adapter",
      });
    } catch (err) {
      const message = formatInvokeError(err);
      set({ liveError: message, orchestratorMode: "idle" });
      applyStatusEvent({
        runId: get().activeRun?.id ?? "failed",
        nodeId: orchestrator.id,
        status: "failed",
        message,
        at: new Date().toISOString(),
        source: "heuristic",
      });
    }
  },

  focusOrchestratorTerminal: async () => {
    if (!isTauri()) {
      set({ liveError: "Focus Terminal only works in the desktop app." });
      return;
    }
    try {
      await invoke("focus_orchestrator_terminal");
      get().appendLiveLog("focused preferred terminal");
    } catch (err) {
      set({ liveError: formatInvokeError(err) });
    }
  },

  markOrchestratorComplete: () => {
    const { activeRun, applyStatusEvent, appendLiveLog } = get();
    if (!activeRun) return;
    applyStatusEvent({
      runId: activeRun.id,
      nodeId: "orchestrator",
      status: "passed",
      message: "Marked complete by user",
      at: new Date().toISOString(),
      source: "adapter",
    });
    appendLiveLog("orchestrator marked complete");
    set({ orchestratorMode: "idle" });
  },

  detachOrchestratorSession: () => {
    const { nodes, edges, graph, activeRun, applyStatusEvent, appendLiveLog } =
      get();
    const next = nodes.map((n) =>
      n.data.role === "orchestrator"
        ? {
            ...n,
            data: {
              ...n.data,
              status: "idle" as const,
              binding: { ...n.data.binding, sessionId: undefined },
            },
          }
        : n,
    );
    set({
      nodes: next,
      graph: fromFlow(graph, next, edges),
      boundSessionId: null,
      orchestratorMode: "idle",
      livePid: null,
    });
    if (activeRun) {
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "orchestrator",
        status: "idle",
        message: "Detached from session",
        at: new Date().toISOString(),
        source: "adapter",
      });
    }
    appendLiveLog("detached orchestrator session");
  },

  startOrchestratorSmoke: async () => {
    const { graph, nodes, applyStatusEvent, appendLiveLog } = get();
    const orchestrator = nodes.find((n) => n.data.role === "orchestrator");
    if (!orchestrator) {
      set({ liveError: "No orchestrator node in graph" });
      return;
    }
    if (!isTauri()) {
      set({
        liveError: "Smoke test only works in the Graph_Enj desktop window.",
      });
      return;
    }

    const now = new Date().toISOString();
    const cwd = graph.repoPath || ".";
    set({
      mode: "monitor",
      liveError: null,
      liveLog: [],
      livePid: null,
      orchestratorMode: "smoke",
      lastCommandPreview: null,
      activeRun: {
        id: "pending",
        graphId: graph.id,
        graphName: graph.name,
        repoPath: cwd,
        status: "running",
        createdAt: now,
        updatedAt: now,
        sessions: {},
        events: [],
      },
    });

    try {
      const result = await invoke<{
        runId: string;
        nodeId: string;
        pid?: number | null;
        display: string;
      }>("start_orchestrator_smoke", {
        nodeId: orchestrator.id,
        cwd,
        smokePrompt: ORCHESTRATOR_SMOKE_PROMPT,
      });
      set((s) => ({
        livePid: result.pid ?? null,
        lastCommandPreview: result.display,
        activeRun: s.activeRun
          ? { ...s.activeRun, id: result.runId }
          : s.activeRun,
      }));
      appendLiveLog(`smoke pid=${result.pid ?? "?"}`);
      appendLiveLog(result.display);
      applyStatusEvent({
        runId: result.runId,
        nodeId: orchestrator.id,
        status: "running",
        message: "headless smoke",
        at: new Date().toISOString(),
        source: "adapter",
      });
    } catch (err) {
      set({ liveError: formatInvokeError(err), orchestratorMode: "idle" });
    }
  },

  stopOrchestratorSmoke: async () => {
    const { activeRun, appendLiveLog, applyStatusEvent } = get();
    if (!isTauri() || !activeRun || activeRun.id === "pending") {
      set({ liveError: "No smoke process to stop" });
      return;
    }
    try {
      await invoke("stop_orchestrator_agent", { runId: activeRun.id });
      appendLiveLog("smoke stop requested");
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "orchestrator",
        status: "failed",
        message: "Smoke stopped by user",
        at: new Date().toISOString(),
        source: "adapter",
      });
      set({ livePid: null, orchestratorMode: "idle" });
    } catch (err) {
      set({ liveError: formatInvokeError(err) });
    }
  },

  startDryRun: () => {
    const { graph, nodes, prompt, applyStatusEvent } = get();
    const runId = uuid();
    const now = new Date().toISOString();
    const orchestrator = nodes.find((n) => n.data.role === "orchestrator");
    const plan = orchestrator
      ? buildNodeCommand({
          runId,
          nodeId: orchestrator.id,
          role: orchestrator.data.role,
          binding: orchestrator.data.binding,
          repoPath: graph.repoPath || ".",
          prompt: [
            prompt,
            "",
            "Graph topology (source of truth) will be injected by Graph_Enj.",
            statusEventHint(runId, orchestrator.id),
          ].join("\n"),
          resumeSessionId: orchestrator.data.binding.sessionId,
        })
      : null;

    const run: RunRecord = {
      id: runId,
      graphId: graph.id,
      graphName: graph.name,
      repoPath: graph.repoPath,
      status: "running",
      createdAt: now,
      updatedAt: now,
      sessions: {},
      events: [],
    };

    set({
      mode: "monitor",
      activeRun: run,
      lastCommandPreview: plan?.display ?? null,
      nodes: nodes.map((n) => ({
        ...n,
        data: { ...n.data, status: "idle" as const },
      })),
    });

    const path = [
      "orchestrator",
      "planner",
      "implement",
      "gate",
      "evaluate",
      "risk",
      "human",
    ] as const;

    path.forEach((nodeId, index) => {
      window.setTimeout(() => {
        applyStatusEvent({
          runId,
          nodeId,
          status: nodeId === "human" ? "waiting_human" : "running",
          message:
            nodeId === "human"
              ? "Awaiting approval"
              : `Node ${nodeId} started`,
          sessionId:
            nodeId === "orchestrator"
              ? orchestrator?.data.binding.sessionId ??
                `cc-sim-${runId.slice(0, 8)}`
              : undefined,
          at: new Date().toISOString(),
          source: index === 2 ? "heuristic" : "adapter",
        });
        if (nodeId !== "human") {
          window.setTimeout(() => {
            applyStatusEvent({
              runId,
              nodeId,
              status: "passed",
              message: `Node ${nodeId} completed`,
              at: new Date().toISOString(),
              source: "adapter",
            });
          }, 450);
        }
      }, index * 700);
    });
  },

  recommendRestart: () => get().activeRun?.failedSubgraphRoot ?? "gate",

  restartFailedSubgraph: () => {
    const { activeRun, applyStatusEvent, recommendRestart } = get();
    if (!activeRun) return;
    const root = recommendRestart() ?? "gate";
    applyStatusEvent({
      runId: activeRun.id,
      nodeId: root,
      status: "queued",
      message: `Restart recommended from failed subgraph: ${root}`,
      at: new Date().toISOString(),
      source: "adapter",
    });
    window.setTimeout(() => {
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: root,
        status: "running",
        message: `Restarting subgraph at ${root}`,
        at: new Date().toISOString(),
        source: "adapter",
      });
    }, 300);
  },

  humanDecide: (decision) => {
    const { activeRun, applyStatusEvent } = get();
    if (!activeRun) return;
    if (decision === "approve") {
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "human",
        status: "passed",
        message: "Approved",
        at: new Date().toISOString(),
        source: "adapter",
      });
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "finalize",
        status: "running",
        at: new Date().toISOString(),
        source: "adapter",
      });
      window.setTimeout(() => {
        applyStatusEvent({
          runId: activeRun.id,
          nodeId: "finalize",
          status: "passed",
          message: "Finalize complete",
          at: new Date().toISOString(),
          source: "adapter",
        });
        set((s) =>
          s.activeRun
            ? { activeRun: { ...s.activeRun, status: "completed" } }
            : {},
        );
      }, 500);
    } else if (decision === "reject") {
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "human",
        status: "failed",
        message: "Rejected",
        at: new Date().toISOString(),
        source: "adapter",
      });
      set((s) =>
        s.activeRun
          ? {
              activeRun: {
                ...s.activeRun,
                status: "failed",
                failedSubgraphRoot: "implement",
              },
            }
          : {},
      );
    } else {
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "human",
        status: "failed",
        message: "Redelegate to repair",
        at: new Date().toISOString(),
        source: "adapter",
      });
      applyStatusEvent({
        runId: activeRun.id,
        nodeId: "repair",
        status: "queued",
        at: new Date().toISOString(),
        source: "adapter",
      });
      set((s) =>
        s.activeRun
          ? {
              activeRun: {
                ...s.activeRun,
                failedSubgraphRoot: "repair",
                status: "running",
              },
            }
          : {},
      );
    }
  },
}));
