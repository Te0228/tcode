/**
 * Tab completion for file paths (spec §15.4).
 *
 * Before this, Tab inserted a literal tab character. Every path in every
 * message had to be typed out in full and correctly, including the ones
 * used for `@` references.
 *
 * Completion is scoped to the project directory for the same reason the
 * file tools are (spec §6): the completer is a discovery surface, and one
 * that happily lists `~/.ssh` is a worse leak than a tool that refuses to
 * read it.
 */
import fs from "node:fs";
import path from "node:path";

/** readline's completer contract: the candidates, and the substring of the
 * line they replace. */
export type CompleterResult = [string[], string];

/** Everything after the last unquoted space — plus the `@` marker, which is
 * part of the token so the replacement keeps it. */
export function tokenAt(line: string): string {
  const match = /(\S*)$/.exec(line);
  return match ? match[1] : "";
}

export function createCompleter(root: string): (line: string) => CompleterResult {
  const resolvedRoot = path.resolve(root);

  return (line: string): CompleterResult => {
    const token = tokenAt(line);
    // `@src/foo` completes the path but keeps the marker on the candidates,
    // so accepting one leaves a usable reference rather than a bare path.
    const mention = token.startsWith("@");
    const typed = mention ? token.slice(1) : token;
    if (!mention && typed === "") return [[], token];

    const separator = typed.lastIndexOf("/");
    const dirPart = separator === -1 ? "" : typed.slice(0, separator + 1);
    const filePart = separator === -1 ? typed : typed.slice(separator + 1);

    const directory = path.resolve(resolvedRoot, dirPart);
    // A `../` that climbs out must not turn Tab into a filesystem browser.
    if (directory !== resolvedRoot && !directory.startsWith(resolvedRoot + path.sep)) {
      return [[], token];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [[], token];
    }

    const prefix = mention ? "@" : "";
    const candidates = entries
      // Hidden files only once the user has typed the dot: otherwise every
      // completion in a repo root is drowned in .git/.tcode/.env.
      .filter((entry) => (filePart.startsWith(".") ? true : !entry.name.startsWith(".")))
      .filter((entry) => entry.name.startsWith(filePart))
      // Trailing slash on directories so a second Tab descends instead of
      // stopping at a path that is not yet a file.
      .map((entry) => `${prefix}${dirPart}${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort();

    return [candidates, token];
  };
}
