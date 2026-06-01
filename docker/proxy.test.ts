import { describe, it, expect } from "vitest";
import { isValidHostname, isSafeGitHubApiRequest } from "./proxy.ts";

describe("isValidHostname", () => {
  it("accepts normal hostnames", () => {
    for (const h of ["github.com", "api.github.com", "registry.npmjs.org", "a.b.c.d.example.co.uk", "x"]) {
      expect(isValidHostname(h)).toBe(true);
    }
  });

  it("rejects anything with shell metacharacters or whitespace", () => {
    for (const h of [
      "github.com; rm -rf /",
      "$(touch /tmp/pwned)",
      "a`id`b",
      "a b",
      "a/b",
      "a|b",
      "../../etc",
      "host\n.com",
      "",
    ]) {
      expect(isValidHostname(h)).toBe(false);
    }
  });
});

describe("isSafeGitHubApiRequest", () => {
  it("treats reads as safe", () => {
    expect(isSafeGitHubApiRequest("GET", "/repos/o/r")).toBe(true);
    expect(isSafeGitHubApiRequest("HEAD", "/repos/o/r/pulls")).toBe(true);
  });

  it("allows issue/PR comments", () => {
    expect(isSafeGitHubApiRequest("POST", "/repos/o/r/issues/12/comments")).toBe(true);
  });

  it("denies destructive writes", () => {
    expect(isSafeGitHubApiRequest("DELETE", "/repos/o/r")).toBe(false);
    expect(isSafeGitHubApiRequest("POST", "/repos/o/r/releases")).toBe(false);
    expect(isSafeGitHubApiRequest("PUT", "/repos/o/r/actions/secrets/X")).toBe(false);
  });
});
