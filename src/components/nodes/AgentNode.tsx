import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { GraphNodeData } from "../../types/graph";

type AgentFlowNode = Node<GraphNodeData, "agent">;

const roleClass: Record<GraphNodeData["role"], string> = {
  orchestrator: "node-manager",
  planner: "node-manager",
  implementer: "node-worker",
  worker: "node-worker",
  repair: "node-worker",
  evaluator: "node-evaluator",
  verifier: "node-evaluator",
  gate: "node-function",
  router: "node-router",
  human: "node-human",
  finalize: "node-final",
};

function AgentNodeView({ data, selected }: NodeProps<AgentFlowNode>) {
  return (
    <div
      className={`agent-node ${roleClass[data.role]} status-${data.status} ${
        selected ? "selected" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="agent-node-title">{data.label}</div>
      <div className="agent-node-sub">{data.description}</div>
      <div className="agent-node-meta">
        <span className="pill">{data.binding.provider}</span>
        {data.binding.canSpawn ? (
          <span className="pill spawn">spawner</span>
        ) : null}
        <span className="pill">{data.binding.permission}</span>
        <span className={`pill status status-${data.status}`}>{data.status}</span>
      </div>
      {data.binding.sessionId ? (
        <div className="agent-node-session">
          session: {data.binding.sessionId}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(AgentNodeView);
