import { describe, expect, it } from "vitest";
import type { SessionState } from "../src/session-manager.js";
import { validateInvariants } from "../src/invariants.js";

describe("session invariants", () => {
  it("accepts a valid tree", () => {
    const state: SessionState = {
      entries: new Map([
        ["root", { id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "session_header", version: 1, sessionId: "s_123", cwd: "/tmp/ws", createdAt: "2026-01-01T00:00:00.000Z" }],
        ["m_0001", { id: "m_0001", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", type: "message", message: { role: "user", timestamp: "2026-01-01T00:00:01.000Z", content: [{ type: "text", text: "hi" }] }, seq: 1 }],
        ["m_0002", { id: "m_0002", parentId: "m_0001", timestamp: "2026-01-01T00:00:02.000Z", type: "message", message: { role: "assistant", timestamp: "2026-01-01T00:00:02.000Z", content: [{ type: "text", text: "hello" }] }, seq: 2 }],
      ]),
      children: new Map([
        ["root", ["m_0001"]],
        ["m_0001", ["m_0002"]],
      ]),
      headerId: "root",
      activeLeafId: "m_0002",
      lastSeq: 2,
    };

    expect(validateInvariants(state).valid).toBe(true);
  });

  it("rejects a broken parent chain", () => {
    const state: SessionState = {
      entries: new Map([
        ["root", { id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "session_header", version: 1, sessionId: "s_123", cwd: "/tmp/ws", createdAt: "2026-01-01T00:00:00.000Z" }],
        ["m_0001", { id: "m_0001", parentId: "missing", timestamp: "2026-01-01T00:00:01.000Z", type: "message", message: { role: "user", timestamp: "2026-01-01T00:00:01.000Z", content: [{ type: "text", text: "hi" }] }, seq: 1 }],
      ]),
      children: new Map([["root", ["m_0001"]]]),
      headerId: "root",
      activeLeafId: "m_0001",
      lastSeq: 1,
    };

    const result = validateInvariants(state);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("missing parent"))).toBe(true);
  });

  it("rejects move backwards in seq", () => {
    const state: SessionState = {
      entries: new Map([
        ["root", { id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "session_header", version: 1, sessionId: "s_123", cwd: "/tmp/ws", createdAt: "2026-01-01T00:00:00.000Z" }],
        ["m_0001", { id: "m_0001", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", type: "message", message: { role: "user", timestamp: "2026-01-01T00:00:01.000Z", content: [{ type: "text", text: "hi" }] }, seq: 3 }],
        ["m_0002", { id: "m_0002", parentId: "m_0001", timestamp: "2026-01-01T00:00:02.000Z", type: "message", message: { role: "assistant", timestamp: "2026-01-01T00:00:02.000Z", content: [{ type: "text", text: "hello" }] }, seq: 2 }],
      ]),
      children: new Map([["root", ["m_0001"]], ["m_0001", ["m_0002"]]]),
      headerId: "root",
      activeLeafId: "m_0002",
      lastSeq: 3,
    };

    const result = validateInvariants(state);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("seq decreased"))).toBe(true);
  });
});
