import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("operator auth", () => {
  it("is disabled when no password is configured", async () => {
    vi.stubEnv("VIVI_OPERATOR_PASSWORD", "");
    const auth = await import("./operator-auth.js");
    expect(auth.isOperatorAuthorized({})).toBe(true);
  });

  it("accepts only the configured basic credentials", async () => {
    vi.stubEnv("VIVI_OPERATOR_USER", "vivi");
    vi.stubEnv("VIVI_OPERATOR_PASSWORD", "correct horse");
    const auth = await import("./operator-auth.js");
    const valid = Buffer.from("vivi:correct horse").toString("base64");
    const invalid = Buffer.from("vivi:wrong").toString("base64");
    expect(auth.isOperatorAuthorized({ authorization: `Basic ${valid}` })).toBe(true);
    expect(auth.isOperatorAuthorized({ authorization: `Basic ${invalid}` })).toBe(false);
    expect(auth.isOperatorAuthorized({})).toBe(false);
  });
});
