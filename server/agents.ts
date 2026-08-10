export const AGENT_IDS = ["claude", "codex"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  executable: string;
  branchPrefix: string;
  profileDirectory: string;
  profileMount: string;
  coAuthor: { name: string; email: string };
}

const DEFINITIONS: Record<AgentId, AgentDefinition> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    branchPrefix: "claude",
    profileDirectory: ".claude",
    profileMount: "/agent-profile",
    coAuthor: { name: "Claude Code", email: "claude-code@anthropic.com" },
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex",
    executable: "codex",
    branchPrefix: "codex",
    profileDirectory: ".codex",
    profileMount: "/agent-profile",
    coAuthor: { name: "OpenAI Codex", email: "noreply@openai.com" },
  },
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_IDS.includes(value as AgentId);
}

export function getAgent(value: unknown): AgentDefinition {
  return DEFINITIONS[isAgentId(value) ? value : "claude"];
}

export function listAgents(): AgentDefinition[] {
  return AGENT_IDS.map((id) => DEFINITIONS[id]);
}
