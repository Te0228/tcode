import path from "node:path";

export class PathEscapesRootError extends Error {
  constructor(
    public readonly inputPath: string,
    public readonly root: string,
  ) {
    super(`path escapes project root: ${inputPath}`);
    this.name = "PathEscapesRootError";
  }
}

/**
 * Resolves `inputPath` against `root` and rejects any result that falls
 * outside `root` (spec §6). Comparison uses `root + path.sep` as the
 * prefix, not just `root`, so a sibling directory that merely shares the
 * same string prefix (e.g. `/proj` vs `/proj-evil`) is not mistaken for
 * being inside it.
 */
export function resolveInRoot(root: string, inputPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, inputPath);

  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapesRootError(inputPath, resolvedRoot);
  }

  return resolved;
}
