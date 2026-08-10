import crypto from "node:crypto";
import type express from "express";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";

const USERNAME = process.env.VIVI_OPERATOR_USER || "vivi";
const PASSWORD = process.env.VIVI_OPERATOR_PASSWORD || "";

export function operatorAuthEnabled(): boolean {
  return PASSWORD.length > 0;
}

function equal(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isOperatorAuthorized(headers: IncomingHttpHeaders): boolean {
  if (!operatorAuthEnabled()) return true;
  const header = headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return equal(decoded.slice(0, separator), USERNAME) && equal(decoded.slice(separator + 1), PASSWORD);
  } catch {
    return false;
  }
}

export function operatorAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.path === "/api/health" || isOperatorAuthorized(req.headers)) {
    next();
    return;
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Vivi", charset="UTF-8"');
  res.status(401).json({ error: "Authentication required" });
}

export function rejectUnauthorizedUpgrade(headers: IncomingHttpHeaders, socket: ServerResponse | import("node:net").Socket): boolean {
  if (isOperatorAuthorized(headers)) return false;
  if ("write" in socket) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
      'WWW-Authenticate: Basic realm="Vivi", charset="UTF-8"\r\n' +
      "Connection: close\r\nContent-Length: 0\r\n\r\n",
    );
  }
  if ("destroy" in socket) socket.destroy();
  return true;
}

