import type { PolicyDecision, PolicyInput, ToolPolicyEngine } from "@kern/protocol";
import { isSensitivePath } from "@kern/protocol";
import type { PolicyConfig } from "./policy-config.js";
import { DEFAULT_POLICY_CONFIG } from "./policy-config.js";

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/,
  /\brm\s+-r\s+-f\b/,
  /\bfind\b.*-delete\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fdx\b/,
  /\b:(){:|:&};:\b/,
];

export class AllowAllPolicy implements ToolPolicyEngine {
  async evaluate(): Promise<PolicyDecision> {
    return { decision: "allow" };
  }
}
export class DefaultPolicy implements ToolPolicyEngine {
  constructor(private config: PolicyConfig = DEFAULT_POLICY_CONFIG) {}

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    const name = input.toolName;
    if (this.config.denylistTools.includes(name)) {
      return { decision: "deny", reason: `Tool ${name} is in denylist` };
    }
    if (this.config.allowlistTools.length > 0 && !this.config.allowlistTools.includes(name)) {
      return { decision: "deny", reason: `Tool ${name} not in allowlist` };
    }
    const args = input.arguments as Record<string, unknown> | undefined;
    if (this.config.blockSensitivePaths && args && typeof args.path === "string") {
      if (isSensitivePath(args.path)) {
        return { decision: "deny", reason: "Access to sensitive path is blocked" };
      }
    }
    if (name === "bash" && args && typeof args.command === "string") {
      const cmd = args.command;
      if (DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))) {
        return { decision: "require_approval", prompt: `Destructive command detected. Approve? ${cmd}` };
      }
      if (this.config.approvalMode === "ask") {
        return { decision: "require_approval", prompt: `Approve bash command? ${cmd}` };
      }
    }
    if ((name === "write" || name === "edit") && this.config.approvalMode === "ask") {
      return { decision: "require_approval", prompt: `Approve ${name} operation?` };
    }
    return { decision: "allow" };
  }
}
