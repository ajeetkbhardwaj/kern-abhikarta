import type { SessionState } from "./session-manager.js";
import type { SessionEntry } from "@kern/protocol";

export interface InvariantResult {
  valid: boolean;
  errors: string[];
}

export function validateInvariants(state: SessionState): InvariantResult {
  const errors: string[] = [];
  if (!state.entries.has(state.headerId)) {
    errors.push(`headerId ${state.headerId} not found`);
  }
  if (!state.entries.has(state.activeLeafId)) {
    errors.push(`activeLeafId ${state.activeLeafId} not found`);
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfs = (id: string, path: string[]) => {
    if (stack.has(id)) {
      errors.push(`cycle detected involving ${id} (path: ${path.join(" -> ")})`);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    const children = state.children.get(id) ?? [];
    for (const c of children) {
      dfs(c, [...path, id]);
    }
    stack.delete(id);
  };
  for (const root of state.children.keys()) {
    if (root === state.headerId) continue;
  }
  dfs(state.headerId, []);
  for (const [id, entry] of state.entries.entries()) {
    if (entry.parentId === null) {
      if (id !== state.headerId) {
        errors.push(`multiple roots or unexpected null-parent: ${id}`);
      }
      continue;
    }
    if (!state.entries.has(entry.parentId)) {
      errors.push(`entry ${id} has missing parent ${entry.parentId}`);
    }
  }
  const active = state.entries.get(state.activeLeafId);
  if (!active) {
    errors.push("activeLeafId points to missing entry");
  }
  let lastSeq = 0;
  for (const e of state.entries.values()) {
    if (typeof e.seq === "number") {
      if (e.seq < lastSeq) {
        errors.push(`seq decreased: ${e.seq} < ${lastSeq}`);
      }
      lastSeq = e.seq;
    }
  }
  return { valid: errors.length === 0, errors };
}
