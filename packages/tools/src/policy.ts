import type { PolicyDecision, PolicyInput, ToolPolicyEngine } from "@kern/protocol";
import { isSensitivePath } from "@kern/protocol";
import type { PolicyConfig } from "./policy-config.js";
import { DEFAULT_POLICY_CONFIG } from "./policy-config.js";

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b.*--force\b|--force\b.*--recursive\b)\b/i,
  /\brm\s+.*--no-preserve-root\b/i,
  /\bfind\b.*-delete\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*\b/,
  /\bgit\s+push\b.*--force\b/,
  /\bdd\b.*\bof=\/dev\//,
  /\bmkfs\b/,
  /\bshred\b/,
  /\bchmod\s+-R\b.*\s\/(\s|$)/,
  /\b: *\(\) *\{[^}]*\} *;/,
  /\bcurl\b.*\|\s*(sh|bash)\b/,
  /\bwget\b.*\|\s*(sh|bash)\b/,
  /\bpython\d?\b.*shutil\.rmtree\b/,
];

const SENSITIVE_CMD_PATTERNS = [
  /\.ssh\//,
  /\.aws\//,
  /\.kern\/auth\.json/,
  /\.git-credentials/,
  /\.config\/gh\//,
  /id_rsa/,
  /\.env\b/,
];

export class AllowAllPolicy implements ToolPolicyEngine {
  async evaluate(): Promise<PolicyDecision> {
    return { decision: "allow" };
  }
}
export class DefaultPolicy implements ToolPolicyEngine {
  private readonly sessionAllowed = new Set<string>();

  constructor(private config: PolicyConfig = DEFAULT_POLICY_CONFIG) {}

  /** Don't ask again for this tool for the rest of the session. */
  allowForSession(toolName: string): void {
    this.sessionAllowed.add(toolName);
  }

  setApprovalMode(mode: PolicyConfig["approvalMode"]): void {
    this.config = { ...this.config, approvalMode: mode };
  }

  approvalMode(): PolicyConfig["approvalMode"] {
    return this.config.approvalMode;
  }

  sessionAllowlist(): string[] {
    return [...this.sessionAllowed];
  }

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
    const auto = this.config.approvalMode === "auto-allowlist" || this.sessionAllowed.has(name);
    if (name === "bash" && args && typeof args.command === "string") {
      const cmd = args.command;
      if (SENSITIVE_CMD_PATTERNS.some((re) => re.test(cmd))) {
        return { decision: "deny", reason: "Bash command touches sensitive credentials path" };
      }
      if (DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))) {
        return { decision: "require_approval", prompt: `Destructive command detected. Approve? ${cmd}` };
      }
      if (this.config.approvalMode === "ask" && !auto) {
        return { decision: "require_approval", prompt: `Approve bash command? ${cmd}` };
      }
    }
    if ((name === "write" || name === "edit") && this.config.approvalMode === "ask" && !auto) {
      return { decision: "require_approval", prompt: `Approve ${name} operation?` };
    }
    // Any non-read tool (MCP plugins, future tools) asks, like bash/write/edit.
    // Read-only tools (read, readOnlyHint MCP) stay always-allowed.
    const effect = input.sideEffect ?? (name === "read" ? "read" : "execute");
    if (effect !== "read" && this.config.approvalMode === "ask" && !auto) {
      return { decision: "require_approval", prompt: `Approve ${name} operation?` };
    }
    return { decision: "allow" };
  }
}
