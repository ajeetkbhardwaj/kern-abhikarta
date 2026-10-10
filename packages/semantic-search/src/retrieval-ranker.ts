export interface RetrievalCandidate {
  path: string;
  score: number;
  reasons: string[];
  symbolMatches?: string[];
}

export class RetrievalRanker {
  score(name: string, path: string, symbolMatches: string[] = []): RetrievalCandidate {
    const loweredPath = path.toLowerCase();
    const loweredName = name.toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    if (loweredPath.includes(loweredName)) {
      score += 40;
      reasons.push("path match");
    }
    if (symbolMatches.some((m) => m.toLowerCase().includes(loweredName))) {
      score += 30;
      reasons.push("symbol match");
    }
    if (loweredPath.includes("src") || loweredPath.includes("packages")) {
      score += 10;
    }
    if (/test|spec/.test(path)) {
      score += 5;
      reasons.push("test file");
    }

    return { path, score, reasons, symbolMatches };
  }
}
