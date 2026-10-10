import { ProjectMemoryStore, type ProjectMemoryNote } from "./memory-store.js";

export class ProjectMemory {
  constructor(private readonly store: ProjectMemoryStore = new ProjectMemoryStore()) {}

  async add(note: Omit<ProjectMemoryNote, "id" | "createdAt">): Promise<ProjectMemoryNote> {
    const entry: ProjectMemoryNote = {
      id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      ...note,
    };
    await this.store.save(entry);
    return entry;
  }

  async upsert(note: ProjectMemoryNote): Promise<ProjectMemoryNote> {
    await this.store.upsert(note);
    return note;
  }

  async remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  async search(query: string): Promise<ProjectMemoryNote[]> {
    return this.store.search(query);
  }

  async recent(limit = 10): Promise<ProjectMemoryNote[]> {
    const notes = await this.store.load();
    return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}
