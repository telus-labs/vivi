/**
 * End-to-end test of the per-session Docker socket proxy: a real client speaks
 * raw HTTP over the session's unix socket, a fake dind upstream answers, and we
 * assert the proxy's namespacing/hardening decisions on the wire.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("./runtime.js", () => ({ runtime: { bin: "docker", composeBin: "docker compose" } }));

const SOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vivi-ns-it-"));
vi.mock("./paths.js", () => ({ paths: () => ({ socketsDir: SOCK_DIR }) }));

// id → owning session label, served by the fake dind /containers/<id>/json
const OWNERS: Record<string, string> = {
  ownedById: "sessA",
  otherSession: "sessB",
};

let fakeDind: http.Server;
let dindPort: number;
let proxy: typeof import("./docker-namespace-proxy.js");
let socketPath: string;

beforeAll(async () => {
  fakeDind = http.createServer((req, res) => {
    const url = req.url || "";
    const m = /^\/v[\d.]+\/containers\/([^/?]+)\/json/.exec(url) || /^\/containers\/([^/?]+)\/json/.exec(url);
    if (req.method === "GET" && m) {
      const owner = OWNERS[m[1]];
      if (!owner) { res.writeHead(404); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Id: m[1], Config: { Labels: { "vivi.session": owner } } }));
      return;
    }
    if (req.method === "POST" && /\/containers\/create/.test(url)) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(201, { "Content-Type": "application/json" });
        // Echo labels + env back so the test can confirm what the proxy injected.
        let labels = {}; let env: string[] = [];
        try { const b = JSON.parse(body); labels = b.Labels ?? {}; env = b.Env ?? []; } catch {}
        res.end(JSON.stringify({ Id: "created123", _labels: labels, _env: env }));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });

  await new Promise<void>((r) => fakeDind.listen(0, "127.0.0.1", r));
  dindPort = (fakeDind.address() as net.AddressInfo).port;

  process.env.DIND_HOST = "127.0.0.1";
  process.env.DIND_PORT = String(dindPort);

  proxy = await import("./docker-namespace-proxy.js");
  const info = await proxy.startSessionProxy("sessA");
  socketPath = info.socketPath!;
});

afterAll(async () => {
  proxy?.stopSessionProxy("sessA");
  await new Promise<void>((r) => fakeDind.close(() => r()));
  try { fs.rmSync(SOCK_DIR, { recursive: true, force: true }); } catch {}
});

/** Send one raw HTTP request over the session socket and return the raw response. */
function request(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath);
    let buf = "";
    c.on("connect", () => c.write(raw));
    c.on("data", (d) => { buf += d.toString(); });
    c.on("close", () => resolve(buf));
    c.on("error", reject);
    setTimeout(() => { c.destroy(); resolve(buf); }, 2000);
  });
}

function httpRequest(method: string, urlPath: string, body?: string): string {
  const payload = body ?? "";
  return [
    `${method} ${urlPath} HTTP/1.1`,
    `Host: docker`,
    `Content-Type: application/json`,
    `Content-Length: ${Buffer.byteLength(payload)}`,
    `Connection: close`,
    ``,
    payload,
  ].join("\r\n");
}

describe("per-session docker proxy (wire)", () => {
  it("rejects a privileged container create with 403", async () => {
    const res = await request(httpRequest("POST", "/v1.43/containers/create",
      JSON.stringify({ Image: "x", HostConfig: { Privileged: true } })));
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(res).toMatch(/privileged/i);
  });

  it("rejects a docker-socket bind mount with 403", async () => {
    const res = await request(httpRequest("POST", "/v1.43/containers/create",
      JSON.stringify({ Image: "x", HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] } })));
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(res).toMatch(/docker\.sock/i);
  });

  it("injects the session label on a clean create and forwards it", async () => {
    const res = await request(httpRequest("POST", "/v1.43/containers/create",
      JSON.stringify({ Image: "alpine", HostConfig: { Binds: ["myvol:/data"] } })));
    expect(res).toMatch(/^HTTP\/1\.1 201/);
    expect(res).toContain("created123");
    expect(res).toContain('"vivi.session":"sessA"');
    // Egress is forced through the in-dind proxy relay.
    expect(res).toContain("HTTP_PROXY=http://172.17.0.1:7443");
    expect(res).toContain("https_proxy=http://172.17.0.1:7443");
  });

  it("forwards a container op for a container owned by this session", async () => {
    const res = await request(httpRequest("GET", "/v1.43/containers/ownedById/json"));
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    expect(res).toContain("ownedById");
  });

  it("blocks a container op for a container owned by another session", async () => {
    const res = await request(httpRequest("GET", "/v1.43/containers/otherSession/json"));
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(res).toMatch(/does not belong/i);
  });

  it("blocks a container op for a non-existent container", async () => {
    const res = await request(httpRequest("GET", "/v1.43/containers/ghost/json"));
    expect(res).toMatch(/^HTTP\/1\.1 403/);
  });
});
