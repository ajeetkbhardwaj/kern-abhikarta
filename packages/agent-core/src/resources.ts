import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  allowedTools?: string[];
}

export interface ProjectContext {
  agentsMd: Array<{ path: string; content: string }>;
  skills: SkillMeta[];
  diagnostics: string[];
}

export interface ResourceLoaderOptions {
  logger?: Logger;
  /** Extra skill search roots beyond the defaults. */
  extraSkillDirs?: string[];
  /** File names treated as project instructions, closest-wins. */
  instructionFiles?: string[];
}

const DEFAULT_INSTRUCTION_FILES = ["AGENTS.md"];
const SKILL_DIR_NAMES = [".agents/skills", ".pi/skills"];

/**
 * Discovers project instructions and skills. Runs once at session start
 * (and on explicit reload). Only metadata enters the system prompt;
 * full skill bodies are read on demand through the `read` tool.
 */
export class ResourceLoader {
  private readonly logger: Logger;
  private readonly extraSkillDirs: string[];
  private readonly instructionFiles: string[];

  constructor(options: ResourceLoaderOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.extraSkillDirs = options.extraSkillDirs ?? [];
    this.instructionFiles = options.instructionFiles ?? DEFAULT_INSTRUCTION_FILES;
  }

  async load(cwd: string): Promise<ProjectContext> {
    const diagnostics: string[] = [];
    const agentsMd = await this.discoverInstructions(cwd, diagnostics);
    const skills = await this.discoverSkills(cwd, diagnostics);
    return { agentsMd, skills, diagnostics };
  }

  private async discoverInstructions(cwd: string, diagnostics: string[]): Promise<ProjectContext["agentsMd"]> {
    const found: ProjectContext["agentsMd"] = [];
    const seen = new Set<string>();
    let dir = resolve(cwd);
    for (;;) {
      for (const file of this.instructionFiles) {
        const candidate = join(dir, file);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        try {
          const st = await stat(candidate);
          if (!st.isFile()) continue;
          const content = await readFile(candidate, "utf8");
          // Unshift so the closest file ends up last (highest precedence).
          found.unshift({ path: candidate, content: content.slice(0, 20_000) });
        } catch {
          // Absent is the common case; ignore.
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      // Stop above the home/project boundary creep: cap walk depth.
      if (found.length >= 4) break;
    }
    return found;
  }

  private async discoverSkills(cwd: string, diagnostics: string[]): Promise<SkillMeta[]> {
    const roots: string[] = [];
    for (const name of SKILL_DIR_NAMES) {
      roots.push(join(resolve(cwd), name));
    }
    roots.push(...this.extraSkillDirs);
    const byName = new Map<string, SkillMeta>();
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const skillFile = join(root, entry, "SKILL.md");
        try {
          const st = await stat(skillFile);
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
        try {
          const content = await readFile(skillFile, "utf8");
          const meta = parseSkillFrontmatter(content, skillFile);
          if (!meta) {
            diagnostics.push(`Skill at ${skillFile} missing name/description; skipped`);
            continue;
          }
          if (!byName.has(meta.name)) byName.set(meta.name, meta);
          else diagnostics.push(`Duplicate skill name "${meta.name}" at ${skillFile}; keeping first`);
        } catch (error) {
          diagnostics.push(`Failed to read skill ${skillFile}: ${String(error)}`);
        }
      }
    }
    return [...byName.values()];
  }
}

/** Minimal frontmatter parser: only `key: value` lines between --- fences. */
export function parseSkillFrontmatter(content: string, path: string): SkillMeta | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  let allowedTools: string[] | undefined;
  for (const line of (match[1] ?? "").split("\n")) {
    const m = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
    if (key === "allowed-tools") {
      const inline = value.match(/^\[(.*)\]$/);
      allowedTools = inline
        ? (inline[1] ?? "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : value.split(/[\s,]+/).filter(Boolean);
    }
  }
  const name = fields["name"];
  const description = fields["description"];
  if (!name || !description) return null;
  const meta: SkillMeta = { name, description, path };
  if (allowedTools) meta.allowedTools = allowedTools;
  return meta;
}

/** Render resource metadata as a system-prompt section. Catalog only. */
export function buildResourceSection(ctx: ProjectContext): string {
  const sections: string[] = [];
  if (ctx.agentsMd.length > 0) {
    const bodies = ctx.agentsMd.map((f) => `### ${f.path}\n${f.content}`).join("\n\n");
    sections.push(`<project_instructions>\n${bodies}\n</project_instructions>`);
  }
  if (ctx.skills.length > 0) {
    const catalog = ctx.skills
      .map((s) => `- ${s.name}: ${s.description} (path: ${s.path})`)
      .join("\n");
    sections.push(
      `<skills>\n${catalog}\n\nWhen a task matches a skill, use the read tool on its SKILL.md path before proceeding. A skill can be forced with /skill:name.\n</skills>`,
    );
  }
  return sections.join("\n\n");
}
