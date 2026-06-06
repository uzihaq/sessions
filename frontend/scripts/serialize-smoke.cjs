#!/usr/bin/env node
// Phase 3.1 smoke test: feed Claude Code-shaped transcripts through a real
// `@xterm/headless` Terminal, run `@xterm/addon-serialize` on the buffer, and
// assert the parser still produces the right blocks from that snapshot.
//
// Why this exists separately from `parser-smoke.cjs`:
// - `parser-smoke.cjs` proves the parser handles hand-crafted ANSI fixtures.
// - `serialize-smoke.cjs` proves the parser handles snapshots in the *exact
//   shape* the frontend hook (`useTerminal` → `serialize.serialize()`) will
//   produce. That shape includes:
//     * `\r\n` line endings (tmux capture-pane defaults to `\n` only)
//     * trailing cursor-positioning CSI escapes appended by SerializeAddon
//     * soft-wrapped lines joined with no separator (matches `capture-pane -J`)
//     * styling SGR runs split mid-line by xterm's diff algorithm
//
// `@xterm/headless` is the same xterm core the browser uses, minus the DOM
// renderer — so this is "production xterm.js + production SerializeAddon",
// not a homebrew approximation. If the bundled xterm version ever changes
// its serialize behavior, this test catches it before users do.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const esbuild = require(path.join(FRONTEND_ROOT, 'node_modules', 'esbuild'));
const { Terminal } = require(path.join(FRONTEND_ROOT, 'node_modules', '@xterm', 'headless'));
const { SerializeAddon } = require(path.join(FRONTEND_ROOT, 'node_modules', '@xterm', 'addon-serialize'));

const tmp = path.join(os.tmpdir(), `pretty-pty-serialize-smoke-${process.pid}.cjs`);
const tmpNorm = path.join(os.tmpdir(), `pretty-pty-serialize-norm-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(FRONTEND_ROOT, 'src', 'parsers', 'detect.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: tmp,
  external: ['react', 'react-dom'],
  logLevel: 'silent'
});
esbuild.buildSync({
  entryPoints: [path.join(FRONTEND_ROOT, 'src', 'lib', 'xtermSnapshot.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: tmpNorm,
  logLevel: 'silent'
});

let mod, normMod;
try {
  mod = require(tmp);
  normMod = require(tmpNorm);
} finally {
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpNorm); } catch { /* ignore */ }
}
const { detectTool } = mod;
const { normalizeXtermSnapshot } = normMod;

// term.write is async — wrap it so we can await the snapshot.
// Returns the serialized buffer AFTER the production normalizer has run,
// matching exactly what usePrettyParser feeds to detectTool().
function snapshot(cols, rows, chunks) {
  return new Promise((resolve) => {
    const term = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true
    });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);

    let i = 0;
    const writeNext = () => {
      if (i >= chunks.length) {
        resolve(normalizeXtermSnapshot(serialize.serialize()));
        return;
      }
      term.write(chunks[i++], writeNext);
    };
    writeNext();
  });
}

const cases = [
  {
    name: 'banner + permissions + user + claude_message at 80 cols',
    cols: 80,
    chunks: [
      ' ▐▛███▜▌  Claude Code v2.1.4\r\n',
      '  ▝▜█▛▘   Sonnet 4.7\r\n',
      '   ▘▘     ~/pretty-PTY\r\n',
      '\r\n',
      '⏵⏵ bypass permissions on\r\n',
      '\r\n',
      '❯ hello there, claude\r\n',
      '\r\n',
      '⏺ Hi! How can I help?\r\n',
      '  I can read files, run commands, and edit code.\r\n',
      '\r\n'
    ],
    expectParser: 'claude-code',
    expectTypes: ['permissions_badge', 'banner', 'user_input', 'claude_message']
  },

  {
    name: 'soft-wrapped long claude_message at narrow cols (parity with tmux capture-pane -J)',
    cols: 40,
    chunks: [
      ' ▐▛███▜▌  Claude Code v2.1.4\r\n',
      '   ▘▘     ~/pretty-PTY\r\n',
      '\r\n',
      '❯ short prompt\r\n',
      '\r\n',
      // Single logical line that will visibly wrap across multiple rows in
      // a 40-col terminal. SerializeAddon should rejoin on serialize and the
      // parser should see ONE claude_message containing the whole sentence.
      '⏺ Hi! Here is a long answer that will definitely wrap across multiple visual rows because the cols are very narrow.\r\n',
      '\r\n'
    ],
    expectParser: 'claude-code',
    expectIncludes: ['claude_message'],
    extraAssert: (blocks) => {
      const msg = blocks.find((b) => b.type === 'claude_message');
      if (!msg) return 'missing claude_message';
      if (!msg.content.includes('multiple visual rows because the cols are very narrow')) {
        return `claude_message lost the wrapped tail: ${JSON.stringify(msg.content)}`;
      }
      // Wrap parity check: the joined text must NOT contain interior newlines
      // (SerializeAddon splits soft wraps with empty separator, just like
      // capture-pane -J joins them).
      if (msg.content.includes('\n')) {
        return `soft wrap leaked a newline into claude_message: ${JSON.stringify(msg.content)}`;
      }
      return null;
    }
  },

  {
    name: 'tool chips after thinking, fed in chunked PTY-style writes',
    cols: 80,
    chunks: [
      ' ▐▛███▜▌  Claude Code v2.1.4\r\n   ▘▘     ~/pretty-PTY\r\n\r\n',
      '❯ research the bug\r\n\r\n',
      '⏺ Searching for stripAnsi\r\n  ⎿ Found 12 matches across 4 files\r\n\r\n',
      '✳ Thinking… (7m 35s · ↓ 1.9k tokens · esc to interrupt)\r\n'
    ],
    expectParser: 'claude-code',
    expectIncludes: ['user_input', 'search_status', 'thinking_active']
  },

  {
    name: 'chunk arrives mid-line then completes (no spurious split)',
    cols: 80,
    chunks: [
      ' ▐▛███▜▌  Claude Code v2.1.4\r\n   ▘▘     ~/pretty-PTY\r\n\r\n❯ hi\r\n\r\n',
      '⏺ Here is a sentence that arrives in two', // no terminator yet
      ' separate writes but is one logical line.\r\n\r\n'
    ],
    expectParser: 'claude-code',
    expectIncludes: ['claude_message'],
    extraAssert: (blocks) => {
      const msg = blocks.find((b) => b.type === 'claude_message');
      if (!msg) return 'missing claude_message';
      const expected = 'Here is a sentence that arrives in two separate writes but is one logical line.';
      if (!msg.content.includes(expected)) {
        return `chunked write split the sentence: ${JSON.stringify(msg.content)}`;
      }
      return null;
    }
  },

  {
    // Regression for the bug found via dump-real-claude-snapshot.cjs:
    // real Claude Code (via Ink) positions banner text using cursor-
    // forward escapes (`\x1b[NC`) instead of literal spaces. Without
    // normalizeXtermSnapshot the parser sees `ClaudeCodev2.1.119` and
    // version/cwd/model all come out empty.
    name: 'banner with cursor-forward spacing (Ink-style)',
    cols: 120,
    chunks: [
      // " ▐▛███▜▌" + 3-cell gap + "Claude" + 1-cell gap + "Code" + 1-cell gap + "v2.1.119"
      ' \x1b[38;5;174m▐▛███▜▌\x1b[39m\x1b[3C\x1b[1mClaude\x1b[1CCode\x1b[1C\x1b[22m\x1b[38;5;246mv2.1.119\x1b[39m\r\n',
      '\x1b[38;5;174m▝▜█████▛▘\x1b[39m\x1b[2C\x1b[38;5;246mOpus\x1b[1C4.7\x1b[39m\r\n',
      '\x1b[38;5;174m  ▘▘ ▝▝\x1b[39m\x1b[4C\x1b[38;5;246m/Users/uzair\x1b[39m\r\n',
      '\r\n',
      '❯ \r\n'
    ],
    expectParser: 'claude-code',
    expectIncludes: ['banner'],
    extraAssert: (blocks) => {
      const banner = blocks.find((b) => b.type === 'banner');
      if (!banner) return 'no banner detected';
      if (banner.metadata.version !== '2.1.119') {
        return `banner.metadata.version expected '2.1.119', got '${banner.metadata.version}'`;
      }
      if (banner.metadata.cwd !== '/Users/uzair') {
        return `banner.metadata.cwd expected '/Users/uzair', got '${banner.metadata.cwd}'`;
      }
      if (!banner.metadata.model || !banner.metadata.model.startsWith('Opus')) {
        return `banner.metadata.model expected to start with 'Opus', got '${banner.metadata.model}'`;
      }
      return null;
    }
  },

  {
    name: 'plain shell output → terminal parser fallback',
    cols: 80,
    chunks: [
      '$ ls\r\n',
      'README.md  package.json\r\n',
      '$ '
    ],
    expectParser: 'terminal'
  }
];

(async () => {
  let pass = 0, fail = 0;
  for (const c of cases) {
    const snap = await snapshot(c.cols, 24, c.chunks);
    const parser = detectTool(snap);
    if (parser.id !== c.expectParser) {
      console.error(`FAIL [${c.name}]: expected parser '${c.expectParser}', got '${parser.id}'`);
      fail++;
      continue;
    }
    if (c.expectParser === 'terminal') {
      console.log(`PASS [${c.name}] → ${parser.id} (snapshot ${snap.length}B)`);
      pass++;
      continue;
    }
    const blocks = parser.parse(snap);
    const types = blocks.map((b) => b.type);
    if (c.expectTypes && JSON.stringify(types) !== JSON.stringify(c.expectTypes)) {
      console.error(`FAIL [${c.name}]: expected exact types ${JSON.stringify(c.expectTypes)}, got ${JSON.stringify(types)}`);
      fail++;
      continue;
    }
    if (c.expectIncludes) {
      let missing = null;
      for (const t of c.expectIncludes) {
        if (!types.includes(t)) { missing = t; break; }
      }
      if (missing) {
        console.error(`FAIL [${c.name}]: expected types to include '${missing}', got ${JSON.stringify(types)}`);
        fail++;
        continue;
      }
    }
    if (c.extraAssert) {
      const err = c.extraAssert(blocks);
      if (err) {
        console.error(`FAIL [${c.name}]: ${err}`);
        fail++;
        continue;
      }
    }
    console.log(`PASS [${c.name}] → ${parser.id} (${types.length} blocks: ${types.join(', ')})`);
    pass++;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
