#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCodexAppServer } from '../dist/codexAppServer.js';
import { CodexAppServerNormalizer } from '../dist/codexAppServerNormalize.js';

const cwd = await mkdtemp(path.join(os.tmpdir(), 'pretty-appserver-smoke-'));
const client = await startCodexAppServer();
const normalizer = new CodexAppServerNormalizer({ sourceId: 'appserver-smoke' });

let completed = false;

const turnCompleted = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error('timed out waiting for turn/completed'));
  }, 120_000);
  timer.unref();

  client.events.on('notification', (notification) => {
    const normalized = normalizer.normalize(notification);
    for (const event of normalized.events) {
      console.log(JSON.stringify({ type: 'normalized', event }));
    }
    if (normalized.working !== null) {
      console.log(JSON.stringify({ type: 'working', working: normalized.working }));
    }
    if (notification.method === 'turn/completed') {
      completed = true;
      clearTimeout(timer);
      console.log(JSON.stringify({ type: 'turn/completed', params: notification.params }));
      resolve();
    }
  });

  client.events.on('serverRequest', (request) => {
    console.log(JSON.stringify({ type: 'serverRequest', method: request.method, id: request.id }));
  });

  client.events.on('error', (error) => {
    if (!completed) reject(error);
  });
});

try {
  const threadId = await client.startThread(cwd);
  console.log(JSON.stringify({ type: 'thread', threadId, cwd }));
  const ack = await client.submitTurn(threadId, "reply 'hi' then stop");
  console.log(JSON.stringify({ type: 'ack', ack }));
  await turnCompleted;
} finally {
  await client.close();
}
