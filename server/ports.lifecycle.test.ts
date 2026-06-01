import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./container.js", () => ({
  getContainerName: (id: string) => `vivi-sandbox-${id}`,
}));
vi.mock("./runtime.js", () => ({
  runtime: { bin: "docker", composeBin: "docker compose" },
}));

import { openPort, closePort, getOpenPorts, setServerPort } from "./ports.js";

setServerPort(7700);

const SID = "sess-lifecycle";

afterEach(() => {
  // Ensure no listeners leak between tests
  for (const pf of getOpenPorts(SID)) closePort(pf.sessionId, pf.containerPort);
});

describe("closePort", () => {
  it("closes a plain localhost forward", () => {
    openPort(SID, 3000);
    expect(getOpenPorts(SID)).toHaveLength(1);
    expect(closePort(SID, 3000)).toBe(true);
    expect(getOpenPorts(SID)).toHaveLength(0);
  });

  it("closes a container-targeted forward (regression: targetHost key mismatch)", () => {
    // Same session+port, but a DinD container IP target — keyed with a
    // targetHost suffix. The old closePort looked up the bare key and missed it.
    openPort(SID, 8080, "172.17.0.5", "myapp");
    expect(getOpenPorts(SID)).toHaveLength(1);
    expect(closePort(SID, 8080)).toBe(true);
    expect(getOpenPorts(SID)).toHaveLength(0);
  });

  it("closes every forward sharing a (session, port) pair", () => {
    openPort(SID, 5000); // localhost
    openPort(SID, 5000, "172.17.0.9", "db"); // container IP
    expect(getOpenPorts(SID)).toHaveLength(2);
    expect(closePort(SID, 5000)).toBe(true);
    expect(getOpenPorts(SID)).toHaveLength(0);
  });

  it("returns false when nothing matches", () => {
    expect(closePort(SID, 9999)).toBe(false);
  });
});
