#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'pretty.cjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pretty-wait-commit-'));
const repo = path.join(scratch, 'repo');
const runnerState = path.join(scratch, 'runners');
const sessionId = 'scratch-wait-session-0001';
const children = new Set();

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commit(subject, filename) {
  fs.writeFileSync(path.join(repo, filename), `${subject}\n`);
  git('add', filename);
  git('-c', 'user.name=Pretty Wait Test', '-c', 'user.email=wait@example.invalid', 'commit', '-m', subject);
  return git('rev-parse', 'HEAD');
}

function runWait(extraArgs) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [
    CLI,
    '--host', '127.0.0.1',
    '--port', '1',
    'wait', 'scratch-wait',
    '--until', 'commit',
    '--json',
    ...extraArgs
  ], {
    env: { ...process.env, PRETTYD_STATE_DIR: runnerState },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
  return { child, done };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(repo);
  fs.mkdirSync(runnerState);
  git('init', '-q');
  const initialSha = commit('initial', 'initial.txt');
  fs.writeFileSync(path.join(runnerState, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    cmd: '/bin/zsh',
    args: [],
    cwd: repo,
    createdAt: Date.now(),
    pid: process.pid
  }));

  // Daemon-down metadata fallback + fs.watch wake hint.
  const normalWait = runWait(['--timeout', '9s']);
  await delay(2_000);
  const expectedSha = commit('wake commit', 'wake.txt');
  const normal = await normalWait.done;
  assert.equal(normal.code, 0, normal.stderr || normal.stdout);
  assert.ok(normal.elapsedMs < 10_000, `commit wait took ${normal.elapsedMs}ms`);
  const normalJson = JSON.parse(normal.stdout);
  assert.equal(normalJson.session, sessionId);
  assert.equal(normalJson.cwd, repo);
  assert.equal(normalJson.baseline, initialSha);
  assert.equal(normalJson.commit, expectedSha);
  assert.equal(normalJson.subject, 'wake commit');
  assert.equal(normalJson.history_rewritten, false);

  // With logs/HEAD absent and reflogs disabled, fs.watch cannot attach. The
  // authoritative 5s poll must still observe the new commit in under 10s.
  git('config', 'core.logAllRefUpdates', 'false');
  fs.rmSync(path.join(repo, '.git', 'logs', 'HEAD'), { force: true });
  const pollWait = runWait(['--timeout', '9s']);
  await delay(2_000);
  const pollSha = commit('poll fallback', 'poll.txt');
  const poll = await pollWait.done;
  assert.equal(poll.code, 0, poll.stderr || poll.stdout);
  assert.ok(poll.elapsedMs >= 4_500 && poll.elapsedMs < 10_000, `poll wait took ${poll.elapsedMs}ms`);
  const pollJson = JSON.parse(poll.stdout);
  assert.equal(pollJson.baseline, expectedSha);
  assert.equal(pollJson.commit, pollSha);
  assert.equal(pollJson.subject, 'poll fallback');
  assert.equal(pollJson.history_rewritten, false);

  // Timeout is a distinct exit-2 condition.
  const timeout = await runWait(['--timeout', '300ms']).done;
  assert.equal(timeout.code, 2, timeout.stderr || timeout.stdout);
  const timeoutJson = JSON.parse(timeout.stdout);
  assert.equal(timeoutJson.reason, 'timeout');
  assert.equal(timeoutJson.baseline, pollSha);

  // --cwd is the last-resort daemon-down override and rejects non-repos
  // immediately with the specified user-error exit code.
  const notRepo = path.join(scratch, 'not-a-repo');
  fs.mkdirSync(notRepo);
  const invalid = await runWait(['--cwd', notRepo, '--timeout', '9s']).done;
  assert.equal(invalid.code, 1, invalid.stderr || invalid.stdout);
  const invalidJson = JSON.parse(invalid.stdout);
  assert.equal(invalidJson.reason, 'not-a-git-repository');

  // Resetting from the baseline to its parent satisfies the predicate and
  // is reported as rewritten history because baseline !< new HEAD.
  const resetWait = runWait(['--timeout', '9s']);
  await delay(2_000);
  git('reset', '--hard', `${pollSha}^`);
  const reset = await resetWait.done;
  assert.equal(reset.code, 0, reset.stderr || reset.stdout);
  assert.ok(reset.elapsedMs < 10_000, `reset wait took ${reset.elapsedMs}ms`);
  const resetJson = JSON.parse(reset.stdout);
  assert.equal(resetJson.baseline, pollSha);
  assert.equal(resetJson.commit, expectedSha);
  assert.equal(resetJson.subject, 'wake commit');
  assert.equal(resetJson.history_rewritten, true);

  process.stdout.write(
    `commit wake: ${normal.elapsedMs}ms -> ${expectedSha}\n` +
    `poll fallback: ${poll.elapsedMs}ms -> ${pollSha}\n` +
    `timeout: exit ${timeout.code}\n` +
    `non-git cwd: exit ${invalid.code}\n` +
    `force reset: ${reset.elapsedMs}ms -> history_rewritten=true\n` +
    '5 scripted scenarios passed\n'
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(scratch, { recursive: true, force: true });
});
