export interface SymbolRecord {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "export";
  file: string;
  startLine: number;
  endLine?: number;
  module?: string;
}

export function extractSymbolsFromText(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = source.split(/\r?\n/);
  const patterns = [
    { regex: /export\s+(?:async\s+)?function\s+(\w+)/g, kind: "function" },
    { regex: /export\s+class\s+(\w+)/g, kind: "class" },
    { regex: /export\s+interface\s+(\w+)/g, kind: "interface" },
    { regex: /export\s+type\s+(\w+)/g, kind: "type" },
    { regex: /export\s+const\s+(\w+)/g, kind: "const" },
  ] as const;

  for (const { regex, kind } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const name = match[1];
      if (!name) continue;
      const lineNumber = source.slice(0, match.index).split(/\r?\n/).length;
      symbols.push({ name, kind, file: filePath, startLine: lineNumber, endLine: lineNumber + 5 });
    }
  }

  return symbols;
}
