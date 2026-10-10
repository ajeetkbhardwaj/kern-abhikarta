import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ProjectMemoryNote {
  id: string;
  type: "decision" | "architecture" | "bug" | "pattern" | "task";
  content: string;
  createdAt: string;
  relatedPaths?: string[];
}

export interface ProjectMemoryStoreOptions {
  root?: string;
}

export class ProjectMemoryStore {
  private readonly root: string;

  constructor(options: ProjectMemoryStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), ".kern", "project-memory");
  }

  async load(): Promise<ProjectMemoryNote[]> {
    const file = this.path();
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as ProjectMemoryNote[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async save(note: ProjectMemoryNote): Promise<void> {
    const file = this.path();
    await mkdir(dirname(file), { recursive: true });
    const current = await this.load();
    current.push(note);
    await writeFile(file, JSON.stringify(current, null, 2), "utf8");
  }

  async upsert(note: ProjectMemoryNote): Promise<ProjectMemoryNote> {
    const file = this.path();
    await mkdir(dirname(file), { recursive: true });
    const current = await this.load();
    const index = current.findIndex((entry) => entry.id === note.id);
    if (index >= 0) {
      current[index] = note;
    } else {
      current.push(note);
    }
    await writeFile(file, JSON.stringify(current, null, 2), "utf8");
    return note;
  }

  async remove(id: string): Promise<boolean> {
    const file = this.path();
    const current = await this.load();
    const next = current.filter((note) => note.id !== id);
    if (next.length === current.length) return false;
    await writeFile(file, JSON.stringify(next, null, 2), "utf8");
    return true;
  }

  async search(query: string): Promise<ProjectMemoryNote[]> {
    const q = query.toLowerCase();
    return (await this.load()).filter((note) => {
      return note.content.toLowerCase().includes(q) || note.type.toLowerCase().includes(q);
    });
  }

  private path(): string {
    return join(this.root, "notes.json");
  }
}
