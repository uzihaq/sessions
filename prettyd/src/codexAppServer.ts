import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { ClientRequest } from './codexProto/ClientRequest.js';
import type { InitializeResponse } from './codexProto/InitializeResponse.js';
import type { ServerNotification } from './codexProto/ServerNotification.js';
import type { ServerRequest } from './codexProto/ServerRequest.js';
import type { ThreadStartResponse } from './codexProto/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from './codexProto/v2/TurnStartResponse.js';

export interface CodexAppServerEventMap {
  notification: [ServerNotification];
  serverRequest: [ServerRequest];
  close: [];
  error: [Error];
}

export interface StartCodexAppServerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface RequestResultMap {
  initialize: InitializeResponse;
  'thread/start': ThreadStartResponse;
  'turn/start': TurnStartResponse;
}

type SupportedRequestMethod = keyof RequestResultMap;
type RequestFor<M extends SupportedRequestMethod> = Extract<ClientRequest, { method: M }>;
type JsonRpcId = string | number;

interface JsonRpcError {
  code?: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  method: SupportedRequestMethod;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const LISTEN_URL_RE = /listening on:\s*(ws:\/\/[^\s]+)/;

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly data: unknown
  ) {
    super(message);
    this.name = 'CodexAppServerRpcError';
  }
}

export class CodexAppServer {
  readonly events = new EventEmitter<CodexAppServerEventMap>();

  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    readonly endpoint: string,
    readonly child: ChildProcess,
    private readonly socket: WebSocket,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ) {
    this.socket.on('message', (data) => this.handleSocketMessage(data));
    this.socket.on('error', (err) => this.events.emit('error', errorFromUnknown(err)));
    this.socket.on('close', () => {
      this.rejectAll(new Error('codex app-server websocket closed'));
      this.events.emit('close');
    });
    this.child.on('error', (err) => this.events.emit('error', errorFromUnknown(err)));
    this.child.on('exit', (code, signal) => {
      if (this.closed) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.events.emit('error', new Error(`codex app-server exited with ${suffix}`));
    });
  }

  async initialize(): Promise<InitializeResponse> {
    return this.request('initialize', {
      clientInfo: {
        name: 'prettyd-appserver-client',
        title: 'prettyd app-server client',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
  }

  async startThread(cwd: string): Promise<string> {
    const response = await this.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      threadSource: 'pretty-pty-appserver'
    });
    return response.thread.id;
  }

  async submitTurn(threadId: string, text: string): Promise<TurnStartResponse> {
    return this.request('turn/start', {
      threadId,
      clientUserMessageId: `pretty-appserver-${randomUUID()}`,
      input: [{ type: 'text', text, text_elements: [] }]
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('codex app-server client closed'));

    const socketClosed = new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      timer.unref();
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      } else {
        this.socket.terminate();
      }
    });

    const childExited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });

    await Promise.all([socketClosed, childExited]);
  }

  private request<M extends SupportedRequestMethod>(
    method: M,
    params: RequestFor<M>['params'],
    timeoutMs: number = this.requestTimeoutMs
  ): Promise<RequestResultMap[M]> {
    if (this.closed) {
      return Promise.reject(new Error('codex app-server client is closed'));
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('codex app-server websocket is not open'));
    }

    const id = this.nextId++;
    const message = { id, method, params } as RequestFor<M>;

    return new Promise<RequestResultMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();

      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as RequestResultMap[M]),
        reject
      });

      this.socket.send(JSON.stringify(message), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(errorFromUnknown(err));
      });
    });
  }

  private handleSocketMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data)) as unknown;
    } catch (err) {
      this.events.emit('error', new Error(`failed to parse app-server message: ${errorFromUnknown(err).message}`));
      return;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) this.handleJsonRpcMessage(item);
      return;
    }
    this.handleJsonRpcMessage(parsed);
  }

  private handleJsonRpcMessage(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (isServerRequest(message)) {
      this.events.emit('serverRequest', message);
      return;
    }
    if (isServerNotification(message)) {
      this.events.emit('notification', message);
      return;
    }
    this.events.emit('error', new Error('received unknown codex app-server message shape'));
  }

  private handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new CodexAppServerRpcError(
        `${pending.method} failed: ${message.error.message}`,
        message.error.code ?? null,
        message.error.data
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

export async function startCodexAppServer(options: StartCodexAppServerOptions = {}): Promise<CodexAppServer> {
  const command = options.command ?? 'codex';
  const args = ['app-server', '--listen', 'ws://127.0.0.1:0', ...(options.args ?? [])];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let socket: WebSocket | null = null;
  let client: CodexAppServer | null = null;
  try {
    const endpoint = await waitForListeningUrl(child, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    socket = await openWebSocket(endpoint, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    client = new CodexAppServer(endpoint, child, socket, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    await client.initialize();
    return client;
  } catch (err) {
    if (client) {
      try { await client.close(); } catch { /* ignore cleanup errors */ }
    } else {
      socket?.terminate();
      child.kill('SIGTERM');
    }
    throw err;
  }
}

function waitForListeningUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  let output = '';

  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const rejectWith = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = LISTEN_URL_RE.exec(output);
      if (!match?.[1]) return;
      cleanup();
      resolve(match[1]);
    };

    const onError = (err: Error): void => {
      rejectWith(err);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      rejectWith(new Error(`codex app-server exited before listening URL was available (${suffix}): ${output.trim()}`));
    };

    const timer = setTimeout(() => {
      rejectWith(new Error(`timed out waiting for codex app-server listening URL: ${output.trim()}`));
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function openWebSocket(endpoint: string, timeoutMs: number): Promise<WebSocket> {
  const socket = new WebSocket(endpoint);
  return new Promise<WebSocket>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };

    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`timed out connecting to codex app-server websocket: ${endpoint}`));
    }, timeoutMs);
    timer.unref();

    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.concat(data).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return isRecord(value) && typeof value.message === 'string';
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || !isJsonRpcId(value.id) || typeof value.method === 'string') return false;
  if (value.error !== undefined && !isJsonRpcError(value.error)) return false;
  return value.result !== undefined || value.error !== undefined;
}

function isServerRequest(value: unknown): value is ServerRequest {
  return isRecord(value) && isJsonRpcId(value.id) && typeof value.method === 'string' && value.params !== undefined;
}

function isServerNotification(value: unknown): value is ServerNotification {
  return isRecord(value) && value.id === undefined && typeof value.method === 'string' && value.params !== undefined;
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
