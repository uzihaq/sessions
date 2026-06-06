// Three-stage content rendering pipeline for Claude message bodies.
//
// Stage 1: ansiToHtml — convert ANSI escape codes (24-bit truecolor, 256
//   color, named, bold/dim/italic) into <span style="..."> markup.
// Stage 2: marked — parse markdown structure (lists, headings, **bold**,
//   `inline code`, fenced ``` blocks, links). marked treats existing inline
//   HTML as raw HTML and leaves the ANSI spans alone, so the two layers
//   compose cleanly.
// Stage 3: linkifyFilePaths — walk the resulting HTML and wrap recognized
//   file paths in vscode://file/ anchor tags.
//
// Order matters: ANSI must come before marked (so marked sees a normal
// markdown document with embedded HTML), and linkify comes last so it can
// see the final HTML structure and skip text inside existing <a> tags.

import { marked } from 'marked';
import { ansiToHtml } from './ansi';
import { linkifyFilePaths } from './filePaths';
import { boxDrawingTablesToMarkdown } from './asciiTable';

// Configure marked once at module load. Defaults are mostly fine; gfm gives
// us GitHub-flavored markdown (tables, strikethrough), breaks: false avoids
// turning every soft newline into a <br> (we already preserve paragraph
// structure via marked's block parsing).
// `breaks: true` is important: Claude Code output has meaningful line
// breaks (tmux captures with -J, which joins terminal-wrapped lines, so
// the \n's that remain are semantic). Without it, structured output like
//   Key: value
//   Key: value
//   ────
//   Key: value
// collapses into a run-on paragraph because marked treats single newlines
// as soft wraps.
marked.setOptions({
  gfm: true,
  breaks: true
});

// Convert terminal-style horizontal rules made of box-drawing / ASCII
// chars into markdown <hr> separators so marked renders them as actual
// rules instead of literal text that glues the surrounding lines
// together. Applied before marked.
const HR_LINE_RE = /^[\s]*([─━═-]{3,})[\s]*$/gm;
function normalizeHorizontalRules(s: string): string {
  return s.replace(HR_LINE_RE, '---');
}

// Wrap every <pre>…</pre> in a container with an inline copy button. The
// button carries data-code-copy so MessageBlock's event delegation can
// spot clicks and copy the sibling <pre>'s textContent to the clipboard.
function addCodeCopyButtons(html: string): string {
  return html.replace(/<pre([\s\S]*?)<\/pre>/g, (match) => {
    return (
      '<div class="code-pre-wrap">' +
      '<button type="button" class="code-copy" data-code-copy aria-label="Copy code">Copy</button>' +
      match +
      '</div>'
    );
  });
}

// LRU-ish cache for rendered HTML, keyed by raw content + cwd. Markdown
// rendering + ANSI conversion + linkification on a long assistant
// message is multi-millisecond work; reusing the result across renders
// when the message body hasn't changed is a major speed win. The cache
// is bounded at ~200 entries — newest evict oldest by insertion order
// when we hit the cap. Per-message ids are unstable across reconnects
// so we key on the content text itself.
const RENDER_CACHE_MAX = 200;
const renderCache = new Map<string, string>();

export function renderContent(raw: string, cwd?: string): string {
  const cacheKey = (cwd ?? '') + '\0' + raw;
  const hit = renderCache.get(cacheKey);
  if (hit !== undefined) {
    // Touch — move to most-recently-used by re-insert. Cheap on a
    // small Map and gives us a poor man's LRU.
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, hit);
    return hit;
  }
  // Pre-stage: box-drawing tables → markdown tables. Runs on raw text
  // so cell ANSI codes survive into the markdown intact, then ansiToHtml
  // turns them into <span>s after marked parses the table structure.
  const withTables = boxDrawingTablesToMarkdown(raw);
  const withAnsi = ansiToHtml(withTables);
  const withRules = normalizeHorizontalRules(withAnsi);
  const withMarkdown = marked.parse(withRules, { async: false }) as string;
  const withLinks = linkifyFilePaths(withMarkdown, cwd || '');
  const result = addCodeCopyButtons(withLinks);
  renderCache.set(cacheKey, result);
  if (renderCache.size > RENDER_CACHE_MAX) {
    // Evict oldest insertion.
    const first = renderCache.keys().next().value;
    if (first !== undefined) renderCache.delete(first);
  }
  return result;
}
