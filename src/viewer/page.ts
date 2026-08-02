/**
 * The viewer's single-file page (spec §13.4). CSS and JS are inlined and
 * nothing is fetched from a CDN: this is a local tool, it should work
 * offline and shouldn't pull in supply-chain risk for a stylesheet.
 */

export function renderPage(sessionId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tcode · ${escapeHtml(sessionId)}</title>
<style>
:root {
  --bg: #fbfbfa; --panel: #fff; --line: #e6e4e0; --text: #23211e;
  --dim: #6f6a63; --accent: #b45309; --ok: #15803d; --err: #b91c1c;
  --sub: #7c3aed;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171614; --panel: #1e1d1a; --line: #302e2a; --text: #e8e5e0;
    --dim: #9a938a; --accent: #f59e0b; --ok: #4ade80; --err: #f87171;
    --sub: #a78bfa;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
header {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: baseline;
  padding: 14px 20px; background: var(--panel);
  border-bottom: 1px solid var(--line);
}
h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.meta { color: var(--dim); font-size: 12.5px; }
.meta b { color: var(--text); font-weight: 600; }
#live { margin-left: auto; font-size: 12px; color: var(--dim); }
#live.on::before {
  content: ""; display: inline-block; width: 7px; height: 7px;
  margin-right: 6px; border-radius: 50%; background: var(--ok);
}
main { max-width: 980px; margin: 0 auto; padding: 20px; }
.ev {
  position: relative; padding: 9px 14px; margin: 3px 0;
  background: var(--panel); border: 1px solid var(--line); border-radius: 7px;
}
.ev[data-depth="1"] { margin-left: 34px; border-left: 3px solid var(--sub); }
.ev[data-depth="2"] { margin-left: 68px; border-left: 3px solid var(--sub); }
.head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.type {
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--dim);
}
.ev.turn_start .type, .ev.turn_end .type { color: var(--accent); }
.ev.subagent_start .type, .ev.subagent_end .type { color: var(--sub); }
.ev.error .type, .ev.failed .type { color: var(--err); }
.title { font-weight: 550; }
.dur { margin-left: auto; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
pre {
  margin: 8px 0 0; padding: 9px 11px; overflow-x: auto;
  background: var(--bg); border: 1px solid var(--line); border-radius: 5px;
  font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; word-break: break-word;
}
pre.clip { max-height: 15em; overflow-y: auto; }
.badge {
  padding: 1px 7px; border-radius: 20px; font-size: 11px; font-weight: 600;
  border: 1px solid var(--line);
}
.badge.ok { color: var(--ok); } .badge.err { color: var(--err); }
.text { white-space: pre-wrap; margin-top: 6px; }
#empty { color: var(--dim); padding: 40px 0; text-align: center; }
footer { max-width: 980px; margin: 0 auto; padding: 0 20px 40px; color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>tcode</h1>
  <span class="meta" id="hdr">${escapeHtml(sessionId)}</span>
  <span id="live"></span>
</header>
<main><div id="log"></div><div id="empty">no events yet</div></main>
<footer>Read-only view of <code>.tcode/traces/${escapeHtml(sessionId)}.jsonl</code></footer>

<script>
const log = document.getElementById("log");
const empty = document.getElementById("empty");
const hdr = document.getElementById("hdr");
const live = document.getElementById("live");

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const ms = (n) => (n == null ? "" : n < 1000 ? n + "ms" : (n / 1000).toFixed(1) + "s");
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);

// One renderer per event type; anything unknown still shows up as raw JSON
// rather than silently vanishing.
const R = {
  session_start: (e) => {
    hdr.innerHTML = \`<b>\${esc(e.provider)}/\${esc(e.model)}</b> · \${esc(e.root)}\` +
      (e.fullAuto ? " · <b>--full-auto</b>" : "");
    return { title: esc(e.provider) + "/" + esc(e.model) };
  },
  turn_start: (e) => ({ title: esc(e.input) }),
  turn_end: (e) => ({
    title: esc(e.outcome) + (e.finish ? " · " + esc(e.finish.summary) : ""),
    badge: e.usage ? e.usage.tokens + " tok" : "",
  }),
  request_start: (e) => ({ title: "iteration " + e.iteration + " · " + esc(e.viewLevel) + " · " + e.tokens + " tok" }),
  request_end: (e) => ({ title: esc(e.stopReason) + " · " + e.toolCount + " tool call(s)" }),
  assistant_text: (e) => ({ text: e.text }),
  tool_call: (e) => ({ title: esc(e.name), pre: JSON.stringify(e.input, null, 2) }),
  approval: (e) => ({
    title: esc(e.name),
    badge: e.decision,
    bad: e.decision === "declined",
  }),
  tool_result: (e) => ({ title: esc(e.name), badge: e.ok ? "ok" : "error", bad: !e.ok, pre: e.content }),
  subagent_start: (e) => ({ title: "[" + esc(e.role) + "] " + esc(e.task) }),
  subagent_end: (e) => ({ title: "[" + esc(e.role) + "] " + esc(e.outcome), pre: e.summary }),
  context_omitted: (e) => ({ title: e.tokens + " tok exceeds budget " + e.budget }),
  compaction: (e) => ({
    title: "up to message " + e.upToIndex,
    badge: e.ok ? "ok" : "failed",
    bad: !e.ok,
    pre: e.ok ? e.summary : e.error,
  }),
  error: (e) => ({ title: esc(e.message), bad: true }),
};

function add(e) {
  const shape = (R[e.type] || ((x) => ({ pre: JSON.stringify(x, null, 2) })))(e);
  const div = document.createElement("div");
  div.className = "ev " + e.type + (shape.bad ? " failed" : "");
  div.dataset.depth = Math.min(e.depth || 0, 2);

  let html = '<div class="head"><span class="type">' + esc(e.type.replace(/_/g, " ")) + "</span>";
  if (shape.title) html += '<span class="title">' + trunc(shape.title, 200) + "</span>";
  if (shape.badge) html += '<span class="badge ' + (shape.bad ? "err" : "ok") + '">' + esc(shape.badge) + "</span>";
  if (e.durationMs != null) html += '<span class="dur">' + ms(e.durationMs) + "</span>";
  html += "</div>";
  if (shape.text) html += '<div class="text">' + esc(shape.text) + "</div>";
  if (shape.pre) html += '<pre class="clip">' + esc(shape.pre) + "</pre>";

  div.innerHTML = html;
  log.appendChild(div);
  empty.style.display = "none";
}

const source = new EventSource("/events");
source.onmessage = (m) => {
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  add(JSON.parse(m.data));
  if (atBottom) window.scrollTo(0, document.body.scrollHeight);
};
source.onopen = () => { live.textContent = "live"; live.className = "on"; };
source.onerror = () => { live.textContent = "disconnected"; live.className = ""; };
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
