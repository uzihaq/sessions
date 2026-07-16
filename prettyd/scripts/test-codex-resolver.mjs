// Regression test for resolving a reattached Codex runner whose rollout
// predates the resolver's normal today/yesterday search window. This reads
// real metadata from ~/.codex/sessions but never writes to it.
//   npm run test:codex-resolver

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexFreshSessionDirs, resolveCodexRolloutPath } from '../src/codexResolver.js';

const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');

function readSessionMeta(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(16_384);
  let firstLine;
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
  if (!firstLine) return null;

  try {
    const parsed = JSON.parse(firstLine);
    const cwd = parsed?.payload?.cwd;
    const timestamp = parsed?.payload?.timestamp ?? parsed?.timestamp;
    const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    return typeof cwd === 'string' && Number.isFinite(timestampMs)
      ? { cwd, timestampMs }
      : null;
  } catch {
    return null;
  }
}

function findOlderRollout() {
  const legacyDirs = new Set(codexFreshSessionDirs());
  const candidates = [];

  for (const year of fs.readdirSync(sessionsDir).sort()) {
    const yearDir = path.join(sessionsDir, year);
    for (const month of fs.readdirSync(yearDir).sort()) {
      const monthDir = path.join(yearDir, month);
      for (const day of fs.readdirSync(monthDir).sort()) {
        const dayDir = path.join(monthDir, day);
        if (legacyDirs.has(dayDir)) continue;

        for (const name of fs.readdirSync(dayDir).sort()) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, name);
          const meta = readSessionMeta(filePath);
          if (meta) candidates.push({ path: filePath, ...meta });
        }
      }
    }
  }

  candidates.sort((a, b) => {
    const ts = b.timestampMs - a.timestampMs;
    return ts !== 0 ? ts : a.path.localeCompare(b.path);
  });

  // Choose the earliest matching rollout at or after its own timestamp,
  // which is the resolver's deterministic selection policy.
  for (const candidate of candidates) {
    const expected = candidates
      .filter((other) =>
        path.dirname(other.path) === path.dirname(candidate.path)
        && other.cwd === candidate.cwd
        && other.timestampMs >= candidate.timestampMs)
      .sort((a, b) => {
        const ts = a.timestampMs - b.timestampMs;
        return ts !== 0 ? ts : a.path.localeCompare(b.path);
      })[0];
    if (expected?.path === candidate.path) return candidate;
  }

  throw new Error(`no older Codex rollout with session metadata found under ${sessionsDir}`);
}

test('resolves an older real rollout from the runner createdAt date', (t) => {
  const candidate = findOlderRollout();
  const result = resolveCodexRolloutPath({
    cwd: candidate.cwd,
    args: [],
    createdAt: candidate.timestampMs
  });

  assert.ok(
    !codexFreshSessionDirs().includes(path.dirname(candidate.path)),
    'fixture must be outside the legacy today/yesterday scan'
  );
  assert.equal(result.reason, 'fresh-match');
  assert.equal(result.path, candidate.path);
  t.diagnostic(`verified ${path.relative(sessionsDir, candidate.path)}`);
});
