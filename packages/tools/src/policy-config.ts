import { z } from "zod";

export type ApprovalMode = "ask" | "never" | "auto-allowlist";
export type AutonomyLevel = "manual" | "supervised" | "bounded" | "autonomous";

export interface PolicyConfig {
  approvalMode: ApprovalMode;
  autonomyLevel: AutonomyLevel;
  workspaceOnly: boolean;
  enforceRealpath: boolean;
  blockSensitivePaths: boolean;
  networkEnabled: boolean;
  allowlistTools: string[];
  denylistTools: string[];
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxTotalToolCalls: number;
  maxWallTimeMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  destructiveAlwaysRequiresApproval: boolean;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  approvalMode: "ask",
  autonomyLevel: "supervised",
  workspaceOnly: true,
  enforceRealpath: true,
  blockSensitivePaths: true,
  networkEnabled: false,
  allowlistTools: [],
  denylistTools: [],
  maxTurns: 50,
  maxToolCallsPerTurn: 30,
  maxTotalToolCalls: 200,
  maxWallTimeMs: 10 * 60 * 1000,
  maxOutputBytes: 30_000,
  maxOutputLines: 400,
  destructiveAlwaysRequiresApproval: true,
};

export const PolicyConfigSchema = z.object({
  approvalMode: z.enum(["ask", "never", "auto-allowlist"]),
  autonomyLevel: z.enum(["manual", "supervised", "bounded", "autonomous"]),
  workspaceOnly: z.boolean(),
  enforceRealpath: z.boolean(),
  blockSensitivePaths: z.boolean(),
  networkEnabled: z.boolean(),
  allowlistTools: z.array(z.string()),
  denylistTools: z.array(z.string()),
  maxTurns: z.number().int().positive(),
  maxToolCallsPerTurn: z.number().int().positive(),
  maxTotalToolCalls: z.number().int().positive(),
  maxWallTimeMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxOutputLines: z.number().int().positive(),
  destructiveAlwaysRequiresApproval: z.boolean(),
});
