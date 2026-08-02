/**
 * Keyboard predicates for the REPL (spec §3.2).
 *
 * Small enough to look unnecessary, and it existed as an inline condition
 * until that condition silently disabled the Esc interrupt for its entire
 * life — see `isInterruptKey`. Anything that can only be exercised through
 * a real terminal belongs in a pure function with a test.
 */

/** The shape readline's `keypress` event provides. */
export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/**
 * True for a bare `Esc`, the primary interrupt key.
 *
 * The trap: readline reports a lone Esc as `{ name: "escape", meta: true }`.
 * `meta` is not a modifier here — Esc *is* the meta prefix, so readline
 * sets the flag on the key that produced it. Rejecting `meta` keys, which
 * looks like ordinary "plain keypress only" hygiene, rejects every Esc
 * there is.
 *
 * Filtering on the name is already enough to keep arrow keys out: they
 * travel through the same escape sequence but readline resolves them to
 * `up`/`down`/`left`/`right` before emitting.
 */
export function isInterruptKey(key: Key | undefined | null): boolean {
  if (!key || key.name !== "escape") return false;
  return !key.ctrl && !key.shift;
}
