import { describe, it, expect, vi } from "vitest";

// Avoid import-time side effects (runtime detection shells out to `docker`,
// paths() creates directories).
vi.mock("./runtime.js", () => ({
  runtime: { bin: "docker", composeBin: "docker compose" },
}));
vi.mock("./paths.js", () => ({
  paths: () => ({ socketsDir: "/tmp/vivi-test-sockets" }),
}));

import { validateHostConfig, parseContainerScopedId, parseExecScopedId, classifyRequest, buildNestedContainerEnv } from "./docker-namespace-proxy.js";

describe("validateHostConfig", () => {
  it("allows an ordinary container", () => {
    expect(validateHostConfig({ Image: "node", HostConfig: {} }).allowed).toBe(true);
  });

  it("allows named volumes and port maps", () => {
    const v = validateHostConfig({
      HostConfig: {
        Binds: ["mydata:/data", "named-vol:/cache:ro"],
        PortBindings: { "3000/tcp": [{ HostPort: "3000" }] },
      },
    });
    expect(v.allowed).toBe(true);
  });

  it("blocks privileged", () => {
    expect(validateHostConfig({ HostConfig: { Privileged: true } }).allowed).toBe(false);
  });

  it("blocks --cap-add", () => {
    expect(validateHostConfig({ HostConfig: { CapAdd: ["SYS_ADMIN"] } }).allowed).toBe(false);
  });

  it("blocks device passthrough", () => {
    const v = validateHostConfig({ HostConfig: { Devices: [{ PathOnHost: "/dev/sda" }] } });
    expect(v.allowed).toBe(false);
  });

  it.each(["PidMode", "NetworkMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"])(
    "blocks %s=host",
    (mode) => {
      expect(validateHostConfig({ HostConfig: { [mode]: "host" } }).allowed).toBe(false);
    },
  );

  it("allows non-host network modes", () => {
    expect(validateHostConfig({ HostConfig: { NetworkMode: "bridge" } }).allowed).toBe(true);
  });

  it("blocks unconfined seccomp/apparmor", () => {
    expect(validateHostConfig({ HostConfig: { SecurityOpt: ["seccomp=unconfined"] } }).allowed).toBe(false);
    expect(validateHostConfig({ HostConfig: { SecurityOpt: ["apparmor=unconfined"] } }).allowed).toBe(false);
  });

  it.each([
    "/var/run/docker.sock:/var/run/docker.sock",
    "/run/docker.sock:/sock",
    "/path/to/docker.sock:/x",
    "/:/host",
    "/etc:/etc",
    "/proc:/proc",
    "/sys:/sys",
    "/var/lib/docker:/x",
  ])("blocks dangerous bind %s", (bind) => {
    expect(validateHostConfig({ HostConfig: { Binds: [bind] } }).allowed).toBe(false);
  });

  it("blocks docker.sock via the Mounts API", () => {
    const v = validateHostConfig({
      HostConfig: { Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock" }] },
    });
    expect(v.allowed).toBe(false);
  });

  it("tolerates a missing HostConfig", () => {
    expect(validateHostConfig({}).allowed).toBe(true);
    expect(validateHostConfig(null).allowed).toBe(true);
  });
});

describe("buildNestedContainerEnv", () => {
  const PROXY = "http://172.17.0.1:7443";

  it("injects proxy vars onto an empty env", () => {
    const env = buildNestedContainerEnv(undefined, PROXY);
    expect(env).toContain(`HTTP_PROXY=${PROXY}`);
    expect(env).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(env).toContain(`https_proxy=${PROXY}`);
    expect(env.some((e) => e.startsWith("NO_PROXY="))).toBe(true);
  });

  it("preserves unrelated env and overrides caller-supplied proxy vars", () => {
    const env = buildNestedContainerEnv(["FOO=bar", "HTTP_PROXY=http://evil:1", "http_proxy=http://evil:1"], PROXY);
    expect(env).toContain("FOO=bar");
    expect(env.filter((e) => e.startsWith("HTTP_PROXY="))).toEqual([`HTTP_PROXY=${PROXY}`]);
    expect(env.filter((e) => e.startsWith("http_proxy="))).toEqual([`http_proxy=${PROXY}`]);
    expect(env).not.toContain("HTTP_PROXY=http://evil:1");
  });
});

describe("parseContainerScopedId", () => {
  it("extracts the id for container-scoped ops", () => {
    expect(parseContainerScopedId("/v1.43/containers/abc123/json")).toBe("abc123");
    expect(parseContainerScopedId("/v1.43/containers/abc123/stop")).toBe("abc123");
    expect(parseContainerScopedId("/v1.43/containers/abc123/exec")).toBe("abc123");
    expect(parseContainerScopedId("/v1.43/containers/abc123")).toBe("abc123");
    expect(parseContainerScopedId("/v1.43/containers/abc123/archive?path=/x")).toBe("abc123");
  });

  it("returns null for collection endpoints", () => {
    expect(parseContainerScopedId("/v1.43/containers/create")).toBeNull();
    expect(parseContainerScopedId("/v1.43/containers/json")).toBeNull();
    expect(parseContainerScopedId("/v1.43/containers/json?all=1")).toBeNull();
    expect(parseContainerScopedId("/v1.43/containers/prune")).toBeNull();
  });

  it("returns null for non-container paths", () => {
    expect(parseContainerScopedId("/v1.43/images/json")).toBeNull();
    expect(parseContainerScopedId("/v1.43/exec/xyz/start")).toBeNull();
    expect(parseContainerScopedId("/_ping")).toBeNull();
    expect(parseContainerScopedId("/v1.43/version")).toBeNull();
  });

  it("handles unversioned paths identically to versioned ones", () => {
    expect(parseContainerScopedId("/containers/abc123/json")).toBe("abc123");
    expect(parseContainerScopedId("/containers/abc123")).toBe("abc123");
    expect(parseContainerScopedId("/containers/create")).toBeNull();
    expect(parseContainerScopedId("/containers/json")).toBeNull();
    expect(parseContainerScopedId("/v1.43.0/containers/abc123/stop")).toBe("abc123");
  });
});

describe("parseExecScopedId", () => {
  it("extracts the exec id, versioned or not", () => {
    expect(parseExecScopedId("/v1.43/exec/xyz/start")).toBe("xyz");
    expect(parseExecScopedId("/exec/xyz/start")).toBe("xyz");
    expect(parseExecScopedId("/exec/xyz/json")).toBe("xyz");
  });

  it("returns null for non-exec paths", () => {
    expect(parseExecScopedId("/v1.43/containers/xyz/exec")).toBeNull();
    expect(parseExecScopedId("/v1.43/images/json")).toBeNull();
  });
});

describe("classifyRequest (default-deny router)", () => {
  it("intercepts create on both versioned and unversioned paths", () => {
    expect(classifyRequest("POST", "/v1.43/containers/create")).toEqual({ kind: "create" });
    expect(classifyRequest("POST", "/containers/create")).toEqual({ kind: "create" });
    expect(classifyRequest("POST", "/containers/create?name=foo")).toEqual({ kind: "create" });
  });

  it("scopes container list on both path forms", () => {
    expect(classifyRequest("GET", "/v1.43/containers/json")).toEqual({ kind: "list" });
    expect(classifyRequest("GET", "/containers/json?all=1")).toEqual({ kind: "list" });
  });

  it("ownership-checks container ops regardless of version prefix", () => {
    expect(classifyRequest("POST", "/v1.43/containers/abc/stop")).toEqual({ kind: "container", id: "abc" });
    expect(classifyRequest("POST", "/containers/abc/stop")).toEqual({ kind: "container", id: "abc" });
    expect(classifyRequest("DELETE", "/containers/abc")).toEqual({ kind: "container", id: "abc" });
  });

  it("ownership-checks exec ops regardless of version prefix", () => {
    expect(classifyRequest("POST", "/v1.43/exec/xyz/start")).toEqual({ kind: "exec", id: "xyz" });
    expect(classifyRequest("POST", "/exec/xyz/start")).toEqual({ kind: "exec", id: "xyz" });
  });

  it("permits known-safe endpoints", () => {
    for (const p of ["/_ping", "/version", "/v1.43/version", "/info", "/v1.43/images/json",
      "/v1.43/build?t=x", "/v1.43/volumes", "/v1.43/networks", "/containers/prune"]) {
      expect(classifyRequest("GET", p).kind).toBe("passthrough");
    }
  });

  it("default-denies unknown / unhandled endpoints", () => {
    expect(classifyRequest("GET", "/v1.43/swarm").kind).toBe("deny");
    expect(classifyRequest("POST", "/v1.43/plugins/pull").kind).toBe("deny");
    expect(classifyRequest("GET", "/v1.43/secrets").kind).toBe("deny");
    expect(classifyRequest("POST", "/containers/create/../../secrets").kind).toBe("deny");
  });

  it("denies wrong methods on create/json", () => {
    expect(classifyRequest("GET", "/containers/create").kind).toBe("deny");
    expect(classifyRequest("DELETE", "/containers/json").kind).toBe("deny");
  });
});
