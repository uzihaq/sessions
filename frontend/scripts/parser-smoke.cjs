#!/usr/bin/env node
// Phase 3 smoke test: bundle frontend/src/parsers/* via esbuild, run a
// handful of synthetic Claude Code / Codex / shell captures through
// detect()+parse(), and assert the block types come out as expected.
//
// This validates that the parser code we carried over from pretty-tmux
// still compiles + runs cleanly in pretty-PTY's stricter tsconfig and
// produces the right block structure when fed a snapshot. The xterm-side
// SerializeAddon path is mechanical (it just concatenates buffer cells
// back into ANSI text) — fixture-fed parser is the brittle bit.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const esbuild = require(path.join(FRONTEND_ROOT, 'node_modules', 'esbuild'));

const tmp = path.join(os.tmpdir(), `pretty-pty-parser-smoke-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(FRONTEND_ROOT, 'src', 'parsers', 'detect.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: tmp,
  // StatusSidebar.tsx is referenced for TYPE imports only, but esbuild
  // doesn't strip those at bundle time — mark React deps as external.
  external: ['react', 'react-dom'],
  logLevel: 'silent'
});

let mod;
try {
  mod = require(tmp);
} finally {
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

const { detectTool, parsers } = mod;

const fixtures = [
  {
    name: 'banner + permissions + user message',
    raw: [
      ' ▐▛███▜▌  Claude Code v2.1.4',
      '  ▝▜█▛▘   Sonnet 4.7',
      '   ▘▘     ~/pretty-PTY',
      '',
      '⏵⏵ bypass permissions on',
      '',
      '❯ hello there, claude',
      '',
      '⏺ Hi! How can I help?',
      '  I can read files, run commands, and edit code.',
      ''
    ].join('\n'),
    expectParser: 'claude-code',
    // Parser unshifts the permissions badge to the very front when the
    // bypass marker is encountered after the banner (parser.ts:663-665).
    // Verified behavior — keeps the badge visible even if the banner
    // scrolled off the top.
    expectTypes: ['permissions_badge', 'banner', 'user_input', 'claude_message']
  },
  {
    name: 'thinking + tool chips',
    raw: [
      ' ▐▛███▜▌  Claude Code v2.1.4',
      '   ▘▘     ~/pretty-PTY',
      '',
      '❯ research the bug',
      '',
      '⏺ Searching for stripAnsi',
      '  ⎿ Found 12 matches across 4 files',
      '',
      '✳ Thinking… (7m 35s · ↓ 1.9k tokens · esc to interrupt)'
    ].join('\n'),
    expectParser: 'claude-code',
    expectIncludes: ['user_input', 'search_status', 'thinking_active']
  },
  {
    name: 'bash tool use',
    raw: [
      ' ▐▛███▜▌  Claude Code v2.1.4',
      '   ▘▘     ~/pretty-PTY',
      '',
      '❯ run tests',
      '',
      '⏺ Bash(npm test)',
      '  ⎿ 42 passing',
      '  ⎿ Done (3s)'
    ].join('\n'),
    expectParser: 'claude-code',
    expectIncludes: ['command']
  },
  {
    name: 'plain shell falls through to terminal parser',
    raw: '$ ls\nREADME.md  package.json\n$ ',
    expectParser: 'terminal'
  }
];

let pass = 0, fail = 0;

for (const fx of fixtures) {
  const parser = detectTool(fx.raw);
  if (parser.id !== fx.expectParser) {
    console.error(`FAIL [${fx.name}]: expected parser '${fx.expectParser}', got '${parser.id}'`);
    fail++;
    continue;
  }
  if (fx.expectParser === 'terminal') {
    console.log(`PASS [${fx.name}] → ${parser.id}`);
    pass++;
    continue;
  }
  const blocks = parser.parse(fx.raw);
  const types = blocks.map((b) => b.type);
  if (fx.expectTypes) {
    if (JSON.stringify(types) !== JSON.stringify(fx.expectTypes)) {
      console.error(`FAIL [${fx.name}]: expected exact block types ${JSON.stringify(fx.expectTypes)}, got ${JSON.stringify(types)}`);
      fail++;
      continue;
    }
  }
  if (fx.expectIncludes) {
    for (const t of fx.expectIncludes) {
      if (!types.includes(t)) {
        console.error(`FAIL [${fx.name}]: expected types to include '${t}', got ${JSON.stringify(types)}`);
        fail++;
        continue;
      }
    }
  }
  console.log(`PASS [${fx.name}] → ${parser.id} (${types.length} blocks: ${types.join(', ')})`);
  pass++;
}

console.log(`\n${pass} passed, ${fail} failed (${parsers.length} parsers registered)`);
process.exit(fail === 0 ? 0 : 1);
