/**
 * Coarse syntax highlighting (spec §16.8).
 *
 * Hand-written rather than pulled from a library, because the libraries in
 * this space are built for browsers: dozens of full grammars and a CSS
 * theme system, to drive a palette that in a terminal has about six usable
 * colours. At that resolution fine-grained highlighting and coarse
 * highlighting look nearly the same, and the dependency cost differs by two
 * orders of magnitude.
 *
 * Five categories is the ceiling: comment, string, number, keyword, and
 * everything else. Splitting further — types versus variables versus
 * functions — cannot be told apart once it lands in six colours.
 */
import type { Palette } from "./theme.js";

export type Language = "c-like" | "hash" | "lisp" | "sql" | "none";

const C_LIKE = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "break", "continue", "class", "extends", "implements", "interface", "type", "enum",
  "import", "export", "from", "as", "default", "new", "delete", "typeof", "instanceof", "in",
  "of", "this", "super", "try", "catch", "finally", "throw", "async", "await", "yield", "static",
  "public", "private", "protected", "readonly", "abstract", "void", "null", "undefined", "true",
  "false", "package", "func", "struct", "chan", "defer", "go", "map", "range", "fn", "impl",
  "trait", "mut", "pub", "use", "match", "where", "Self", "self",
]);

const HASH = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
  "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "pass",
  "yield", "async", "await", "global", "nonlocal", "True", "False", "None", "self",
  "echo", "then", "fi", "do", "done", "case", "esac", "local", "export", "function",
]);

const SQL = new Set([
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create",
  "table", "drop", "alter", "index", "join", "left", "right", "inner", "outer", "on", "group",
  "order", "by", "having", "limit", "offset", "and", "or", "not", "null", "as", "distinct",
]);

/**
 * Language from a filename or a fence tag. Unknown means unhighlighted:
 * guessing wrong is worse than plain text, because rendering Python's `#`
 * comment as C code tells the reader something false.
 */
export function detectLanguage(hint: string): Language {
  const tag = hint.toLowerCase().split("/").pop() ?? "";
  const extension = tag.includes(".") ? (tag.split(".").pop() ?? "") : tag;

  switch (extension) {
    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs":
    case "java": case "c": case "h": case "cpp": case "hpp": case "cc":
    case "cs": case "go": case "rs": case "swift": case "kt": case "scala":
    case "php": case "json": case "javascript": case "typescript":
      return "c-like";
    case "py": case "python": case "rb": case "ruby": case "sh": case "bash": case "zsh":
    case "yml": case "yaml": case "toml": case "ini": case "conf": case "dockerfile":
    case "makefile": case "mk": case "r": case "pl": case "perl":
      return "hash";
    case "el": case "lisp": case "clj": case "scm":
      return "lisp";
    case "sql":
      return "sql";
    default:
      return "none";
  }
}

interface Syntax {
  lineComment: string[];
  keywords: Set<string>;
}

const SYNTAX: Record<Exclude<Language, "none">, Syntax> = {
  "c-like": { lineComment: ["//"], keywords: C_LIKE },
  hash: { lineComment: ["#"], keywords: HASH },
  lisp: { lineComment: [";"], keywords: new Set() },
  sql: { lineComment: ["--"], keywords: SQL },
};

/**
 * Colours one line. Never changes its display width — the frame erase in
 * §3.2 counts rows from measured widths, and a highlighter that added or
 * dropped a character would corrupt the redraw (spec §16.8).
 */
export function highlight(line: string, language: Language, palette: Palette): string {
  if (language === "none") return line;
  const syntax = SYNTAX[language];

  let out = "";
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    const comment = syntax.lineComment.find((marker) => rest.startsWith(marker));
    if (comment) {
      // A line comment runs to the end, so nothing after it needs scanning.
      out += palette.meta(rest);
      return out;
    }

    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const end = findStringEnd(rest, quote);
      out += palette.success(rest.slice(0, end));
      index += end;
      continue;
    }

    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      out += syntax.keywords.has(word[0]) ? palette.accent(word[0]) : word[0];
      index += word[0].length;
      continue;
    }

    const number = /^\d[\d._a-fA-FxX]*/.exec(rest);
    if (number) {
      out += palette.code(number[0]);
      index += number[0].length;
      continue;
    }

    out += line[index];
    index += 1;
  }

  return out;
}

/** Index just past the closing quote, or the end of the line for a string
 * that continues onto the next one. */
function findStringEnd(text: string, quote: string): number {
  for (let index = 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }
  return text.length;
}
