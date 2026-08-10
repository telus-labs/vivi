import { describe, expect, it } from "vitest";
import { getAgent, isAgentId, listAgents } from "./agents.js";

describe("agent definitions", () => {
  it("lists Claude and Codex as first-class agents", () => {
    expect(listAgents().map((agent) => agent.id)).toEqual(["claude", "codex"]);
  });

  it("defaults legacy or invalid values to Claude", () => {
    expect(getAgent(undefined).id).toBe("claude");
    expect(getAgent("unknown").id).toBe("claude");
  });

  it("recognizes supported ids", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("other")).toBe(false);
  });
});
