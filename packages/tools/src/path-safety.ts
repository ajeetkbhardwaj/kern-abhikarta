import { promises as fs, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, relative } from "node:path";

export async function safeResolve(root: string, p: string): Promise<string> {
  const abs = isAbsolute(p) ? normalize(p) : normalize(resolve(root, p));
  const realRoot = await fs.realpath(root).catch(() => resolve(root));
  const realAbs = await fs.realpath(abs).catch(() => abs);
  const rel = relative(realRoot, realAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return realAbs;
}

export function safeResolveSync(root: string, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(resolve(root, p));
  let rRoot = resolve(root);
  let rAbs = abs;
  try {
    rRoot = realpathSync(root) as string;
  } catch {
    rRoot = resolve(root);
  }
  try {
    rAbs = realpathSync(abs) as string;
  } catch {
    rAbs = abs;
  }
  const rel = relative(rRoot, rAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return rAbs;
}
