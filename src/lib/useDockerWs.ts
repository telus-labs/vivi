import { useState, useEffect, useRef, useCallback } from "react";
import type { DockerContainer, DockerLogEntry, DockerWsOutgoing } from "./types";
import { getWsBase } from "./backend";

const MAX_LOG_LINES = 5000;

export interface UseDockerWs {
  containers: DockerContainer[];
  connected: boolean;
  subscribeLogs: (containerId: string, tail?: number) => void;
  unsubscribeLogs: (containerId: string) => void;
  requestInspect: (containerId: string) => void;
  logs: Map<string, DockerLogEntry[]>;
  inspectData: Map<string, Record<string, any>>;
  clearLogs: (containerId: string) => void;
}

export function useDockerWs(sessionId: string): UseDockerWs {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Map<string, DockerLogEntry[]>>(new Map());
  const [inspectData, setInspectData] = useState<Map<string, Record<string, any>>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const subscriptionsRef = useRef<Map<string, number>>(new Map());
  const pendingRef = useRef<object[]>([]);
  const logBufferRef = useRef<Map<string, DockerLogEntry[]>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    // Batched flush — a chatty container would otherwise clone the Map and re-render per line
    function flushLogs() {
      flushTimerRef.current = null;
      const buffer = logBufferRef.current;
      if (buffer.size === 0) return;
      logBufferRef.current = new Map();
      setLogs((prev) => {
        const next = new Map(prev);
        for (const [containerId, entries] of buffer) {
          const updated = [...(next.get(containerId) ?? []), ...entries];
          next.set(containerId, updated.length > MAX_LOG_LINES
            ? updated.slice(updated.length - MAX_LOG_LINES)
            : updated);
        }
        return next;
      });
    }

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(
        `${getWsBase()}/docker?sessionId=${encodeURIComponent(sessionId)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        // Restore log subscriptions lost on reconnect, then flush queued sends
        for (const [containerId, tail] of subscriptionsRef.current) {
          ws.send(JSON.stringify({ type: "subscribe_logs", containerId, tail }));
        }
        const queued = pendingRef.current;
        pendingRef.current = [];
        for (const msg of queued) ws.send(JSON.stringify(msg));
      };

      ws.onmessage = (event) => {
        try {
          const msg: DockerWsOutgoing = JSON.parse(event.data);
          if (msg.type === "containers") {
            setContainers(msg.data);
          } else if (msg.type === "log") {
            const entry: DockerLogEntry = { stream: msg.stream, data: msg.data };
            const buf = logBufferRef.current.get(msg.containerId);
            if (buf) buf.push(entry);
            else logBufferRef.current.set(msg.containerId, [entry]);
            if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushLogs, 100);
          } else if (msg.type === "log_end") {
            // Keep logs, just stop updating
          } else if (msg.type === "inspect") {
            setInspectData((prev) => {
              const next = new Map(prev);
              next.set(msg.containerId, msg.data);
              return next;
            });
          }
        } catch (err) { console.warn("Failed to parse Docker WebSocket message:", err); }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = (err) => { console.warn("Docker WebSocket error:", err); };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      logBufferRef.current = new Map();
      // Don't replay one session's subscriptions on another session's socket
      subscriptionsRef.current = new Map();
      pendingRef.current = [];
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      pendingRef.current.push(msg);
    }
  }, []);

  // Subscriptions live in a ref so onopen replays them after reconnect — no queueing needed
  const subscribeLogs = useCallback((containerId: string, tail?: number) => {
    const t = tail ?? 500;
    subscriptionsRef.current.set(containerId, t);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe_logs", containerId, tail: t }));
    }
  }, []);

  const unsubscribeLogs = useCallback((containerId: string) => {
    subscriptionsRef.current.delete(containerId);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe_logs", containerId }));
    }
  }, []);

  const requestInspect = useCallback((containerId: string) => {
    send({ type: "inspect", containerId });
  }, [send]);

  const clearLogs = useCallback((containerId: string) => {
    logBufferRef.current.delete(containerId);
    setLogs((prev) => {
      const next = new Map(prev);
      next.set(containerId, []);
      return next;
    });
  }, []);

  return {
    containers,
    connected,
    subscribeLogs,
    unsubscribeLogs,
    requestInspect,
    logs,
    inspectData,
    clearLogs,
  };
}
