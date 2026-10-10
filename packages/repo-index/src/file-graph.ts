export interface FileGraphNode {
  path: string;
  imports: string[];
  exports: string[];
}

export class FileGraph {
  private readonly nodes = new Map<string, FileGraphNode>();

  add(path: string, imports: string[] = [], exports: string[] = []): void {
    this.nodes.set(path, { path, imports: [...new Set(imports)], exports: [...new Set(exports)] });
  }

  get(path: string): FileGraphNode | undefined {
    return this.nodes.get(path);
  }

  all(): FileGraphNode[] {
    return [...this.nodes.values()];
  }

  related(path: string, depth = 1): string[] {
    const seen = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [{ path, depth: 0 }];
    const result = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > depth) continue;
      const node = this.nodes.get(current.path);
      if (!node) continue;
      for (const p of node.imports) {
        if (seen.has(p)) continue;
        seen.add(p);
        result.add(p);
        queue.push({ path: p, depth: current.depth + 1 });
      }
      for (const p of node.exports) {
        if (seen.has(p)) continue;
        seen.add(p);
        result.add(p);
      }
    }

    return [...result].filter((p) => p !== path);
  }
}
