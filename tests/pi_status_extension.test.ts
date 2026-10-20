import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

type Spawned = { args: string[]; cwd: string; prompt: string };
let spawned: Spawned[] = [];
let spawnResult: number | 'error' | 'throw' = 0;
let onSpawn: ((spawn: Spawned) => void) | undefined;

mock.module('node:child_process', () => ({
  spawn(_command: string, args: string[], options: { cwd: string }) {
    if (spawnResult === 'throw') throw new Error('spawn failed');
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end(data: string): void } };
    const stdin = new EventEmitter() as EventEmitter & { end(data: string): void };
    stdin.end = (data: string) => {
      const record = { args, cwd: options.cwd, prompt: JSON.parse(data).prompt };
      spawned.push(record);
      onSpawn?.(record);
      queueMicrotask(() => {
        if (spawnResult === 'error') child.emit('error', new Error('ENOENT'));
        else child.emit('close', spawnResult);
      });
    };
    child.stdin = stdin;
    return child;
  },
}));

// Drive real lifecycle intervals and RPC deadlines without wall-clock sleeps.
type Timer = { callback: () => void; at: number; repeat?: number; unref(): void };
const timers = new Set<Timer>();
let clock = 0;
function schedule(callback: () => void, delay: number, repeat?: number) {
  const timer: Timer = { callback, at: clock + delay, repeat, unref() {} };
  timers.add(timer);
  return timer;
}
mock.module('node:timers', () => ({
  setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
  clearInterval: (timer: Timer) => timers.delete(timer),
  setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
  clearTimeout: (timer: Timer) => timers.delete(timer),
}));
afterEach(() => { timers.clear(); clock = 0; });

const { default: workmuxStatusExtension } = await import('../resources/pi/extensions/workmux-status');
type RpcRequest = { version: number; requestId: string; method: string };

type Handler = (event: unknown, context: unknown) => Promise<void> | void;
type Listener = (data: unknown) => Promise<void> | void;
type AssistantMessage = {
  role: 'assistant';
  stopReason: string;
  errorMessage?: string;
};

const stoppedMessage = (): AssistantMessage => ({
  role: 'assistant',
  stopReason: 'stop',
});

const abortedMessages: AssistantMessage[] = [
  { role: 'assistant', stopReason: 'aborted' },
  { role: 'assistant', stopReason: 'error', errorMessage: 'The operation was aborted.' },
];

async function createHarness(
  initialMessage = stoppedMessage(),
  options: {
    snapshot?: number;
    subagents?: number;
    child?: boolean;
    disabled?: boolean;
    idle?: boolean;
    exec?: (args: string[]) => Promise<number>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Set<Promise<void>>();
  const calls: string[][] = [];
  const statuses: string[] = [];
  let branch = [{ type: 'message', message: initialMessage }];
  spawned = [];
  spawnResult = 0;
  onSpawn = (record) => {
    if (record.args[0] === 'set-window-status' && spawnResult === 0) statuses.push(record.args[1]);
  };
  let idle = options.idle ?? true;
  const events = {
    on(name: string, listener: Listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => { listeners.get(name)!.delete(listener); };
    },
    emit(name: string, data: unknown) {
      // Pi invokes listeners synchronously but does not await their promises.
      for (const listener of listeners.get(name) ?? []) {
        const promise = Promise.resolve(listener(data));
        pending.add(promise);
        void promise.finally(() => pending.delete(promise));
      }
    },
  };
  let stopPublisher: (() => void) | undefined;
  if (options.snapshot !== undefined) {
    stopPublisher = events.on('suba:activity:request', () => {
      events.emit('suba:activity', { activeCount: options.snapshot });
    });
  }
  const requests: RpcRequest[] = [];
  let subagents = options.subagents;
  let replyEnabled = true;
  const reply = (request: RpcRequest, payload: unknown) => {
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, payload);
  };
  const statusReply = (request: RpcRequest, count: unknown) => ({
    version: 1, requestId: request.requestId, method: 'status', success: true,
    data: { fleet: { version: 1, totalActive: count, entries: [], omitted: count } },
  });
  events.on('subagents:rpc:v1:request', (data) => {
    const request = data as RpcRequest;
    requests.push(request);
    if (subagents !== undefined && replyEnabled && request.version === 1 && request.method === 'status') {
      reply(request, statusReply(request, subagents));
    }
  });
  const pi = {
    events,
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const code = await options.exec?.(args) ?? 0;
      if (args[0] === 'set-window-status' && code === 0) statuses.push(args[1]);
      return { stdout: '', stderr: '', code, killed: false };
    },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  const originalChild = process.env.PI_SUBAGENT_CHILD;
  const originalDisabled = process.env.WORKMUX_DISABLE_SET_WINDOW_STATUS;
  try {
    if (options.child) process.env.PI_SUBAGENT_CHILD = '1';
    if (options.disabled) process.env.WORKMUX_DISABLE_SET_WINDOW_STATUS = '';
    workmuxStatusExtension(pi as never);
  } finally {
    if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = originalChild;
    if (originalDisabled === undefined) delete process.env.WORKMUX_DISABLE_SET_WINDOW_STATUS;
    else process.env.WORKMUX_DISABLE_SET_WINDOW_STATUS = originalDisabled;
  }

  const harness = {
    calls,
    statuses,
    requests,
    reply,
    statusReply,
    setSubagents(count: number) { subagents = count; },
    pauseReplies() { replyEnabled = false; },
    resumeReplies() { replyEnabled = true; },
    events,
    listeners,
    stopPublisher() { stopPublisher?.(); },
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
    async activity(activeCount: number) {
      events.emit('suba:activity', { activeCount });
      await this.flush();
    },
    async tick(milliseconds: number, drain = true) {
      const end = clock + milliseconds;
      while (true) {
        const timer = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        clock = timer.at;
        if (timer.repeat) timer.at += timer.repeat;
        else timers.delete(timer);
        timer.callback();
        if (drain) await this.flush();
      }
      clock = end;
      if (drain) await this.flush();
    },
    setMessage(message: AssistantMessage) {
      branch = [...branch, { type: 'message', message }];
    },
    async input(text: string, source = 'interactive', cwd = '/project') {
      await handlers.get('input')?.({ type: 'input', text, source }, { cwd });
    },
    async emit(name: string, isIdle?: boolean) {
      if (name === 'agent_start') idle = false;
      if (name === 'agent_settled') idle = true;
      if (isIdle !== undefined) idle = isIdle;
      await handlers.get(name)?.({}, {
        isIdle: () => idle,
        sessionManager: { getBranch: () => branch },
      });
    },
  };
  await harness.emit('session_start');
  await harness.flush();
  return harness;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('pi-subagents workmux integration', () => {
  test.each([0, 2, 200])('restores current-session fleet activity, including omitted entries (%i)', async (count) => {
    const harness = await createHarness(stoppedMessage(), { subagents: count });
    expect(harness.statuses.at(-1)).toBe(count > 0 ? 'working' : 'done');
  });

  test('keeps a settled parent working until all async work finishes', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 2 });
    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    harness.setSubagents(1);
    await harness.tick(3_000);
    expect(harness.statuses).not.toContain('done');
    harness.setSubagents(0);
    await harness.tick(3_000);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test('keeps a busy parent working after the final child finishes', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    await harness.emit('agent_start');
    harness.setSubagents(0);
    await harness.tick(3_000);
    expect(harness.statuses).not.toContain('done');
    await harness.emit('agent_settled');
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test('refreshes at parent settlement instead of waiting for the poll', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 0 });
    await harness.emit('agent_start');
    harness.setSubagents(1);
    const start = harness.statuses.length;
    await harness.emit('agent_settled');
    expect(harness.statuses.slice(start)).not.toContain('done');
    harness.setSubagents(0);
    await harness.tick(3_000);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test('does not apply a snapshot taken before an async launch notice', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 0 });
    await harness.emit('agent_start');
    harness.pauseReplies();
    await harness.tick(3_000);
    const old = harness.requests.at(-1)!;
    harness.setSubagents(1);
    harness.events.emit('subagent:async-started', {});
    await harness.flush();
    const before = harness.statuses.length;
    const settlement = harness.emit('agent_settled');
    harness.resumeReplies();
    harness.reply(old, harness.statusReply(old, 0));
    await settlement;
    await harness.flush();
    expect(harness.statuses.slice(before)).not.toContain('done');
    expect(harness.statuses.at(-1)).toBe('working');
  });

  test('bounds the entire settlement refresh even when every reply is superseded', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 0 });
    await harness.emit('agent_start');
    harness.pauseReplies();
    let finished = false;
    const settlement = harness.emit('agent_settled').then(() => { finished = true; });
    for (let attempt = 0; attempt < 2; attempt++) {
      await harness.tick(750);
      const request = harness.requests.at(-1)!;
      harness.events.emit('subagent:async-started', {});
      harness.reply(request, harness.statusReply(request, 0));
      await harness.flush();
      expect(finished).toBe(false);
    }
    await harness.tick(500);
    // Drain lifecycle and command continuations without advancing fake time.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(true);
    expect(harness.statuses.at(-1)).toBe('working');
    await settlement;
    // Tracking continues after the lifecycle wait expires; only a fresh zero
    // snapshot may clear the conservative working status.
    const current = harness.requests.at(-1)!;
    harness.reply(current, harness.statusReply(current, 0));
    await harness.flush();
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test.each(['absent', 'legacy'] as const)('stops discovery probes for an %s owner but can discover one later', async (kind) => {
    const harness = await createHarness();
    if (kind === 'legacy') {
      const request = harness.requests.at(-1)!;
      harness.reply(request, { version: 1, requestId: request.requestId, success: true, data: { text: 'old API' } });
      await harness.flush();
    }
    await harness.tick(60_000);
    expect(harness.requests.length).toBeLessThanOrEqual(3);
    const before = harness.requests.length;
    await harness.tick(60_000);
    expect(harness.requests.length).toBe(before);
    expect(harness.statuses).toEqual([]);
    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    expect(harness.statuses.at(-1)).toBe('done');
    harness.setSubagents(1);
    harness.events.emit('subagents:rpc:v1:ready', { version: 1 });
    await harness.flush();
    expect(harness.statuses.at(-1)).toBe('working');
    const reports = harness.statuses.length;
    await harness.tick(3_000);
    expect(harness.statuses.slice(reports)).toEqual(['working']);
  });

  test('coalesces heartbeats behind a slow command without delaying the final done with a backlog', async () => {
    const blocked = deferred();
    let slow = false;
    const harness = await createHarness(stoppedMessage(), {
      subagents: 1,
      exec: async (args) => {
        if (slow && args[0] === 'set-window-status' && args[1] === 'working') await blocked.promise;
        return 0;
      },
    });
    slow = true;
    const before = harness.statuses.length;
    await harness.tick(3_000, false);
    await harness.tick(12_000, false);
    harness.setSubagents(0);
    await harness.tick(3_000, false);
    slow = false;
    blocked.resolve();
    await harness.flush();
    expect(harness.statuses.slice(before)).toEqual(['working', 'done']);
  });

  test('heartbeats quiet delegated work beyond the sidebar inactivity timeout', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    for (let elapsed = 0; elapsed < 15_000; elapsed += 3_000) {
      const before = harness.statuses.length;
      await harness.tick(3_000);
      expect(harness.statuses.slice(before)).toEqual(['working']);
    }
    harness.setSubagents(0);
    await harness.tick(3_000);
    const stopped = harness.statuses.length;
    await harness.tick(6_000);
    expect(harness.statuses.length).toBe(stopped);
  });

  test('discovers a late owner and refreshes on async lifecycle hints', async () => {
    const harness = await createHarness();
    harness.setSubagents(1);
    harness.events.emit('subagents:rpc:v1:ready', { version: 1 });
    await harness.flush();
    expect(harness.statuses.at(-1)).toBe('working');
    harness.setSubagents(0);
    harness.events.emit('subagent:async-complete', { id: 'run' });
    await harness.flush();
    expect(harness.statuses.at(-1)).toBe('done');
    harness.setSubagents(1);
    harness.events.emit('subagent:async-started', { id: 'new-run' });
    await harness.flush();
    expect(harness.statuses.at(-1)).toBe('working');
  });

  test('combines pi-suba and pi-subagents without either clearing the other', async () => {
    const harness = await createHarness(stoppedMessage(), { snapshot: 1, subagents: 1 });
    await harness.activity(0);
    expect(harness.statuses.at(-1)).toBe('working');
    await harness.activity(1);
    harness.setSubagents(0);
    await harness.tick(3_000);
    expect(harness.statuses.at(-1)).toBe('working');
    await harness.activity(0);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test.each([null, -1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid fleet counts without clearing or heartbeating work (%s)', async (count) => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    harness.pauseReplies();
    await harness.tick(3_000);
    const before = harness.statuses.length;
    const request = harness.requests.at(-1)!;
    harness.reply(request, harness.statusReply(request, count));
    await harness.flush();
    expect(harness.statuses.length).toBe(before);
  });

  test('ignores failed, incompatible and uncorrelated replies, then recovers', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    harness.pauseReplies();
    await harness.tick(3_000);
    const before = harness.statuses.length;
    const request = harness.requests.at(-1)!;
    harness.reply(request, { ...harness.statusReply(request, 0), requestId: 'other' });
    harness.reply(request, { ...harness.statusReply(request, 0), version: 2 });
    harness.reply(request, { version: 1, requestId: request.requestId, success: false });
    await harness.flush();
    await harness.tick(3_000);
    const next = harness.requests.at(-1)!;
    harness.reply(next, { ...harness.statusReply(next, 0), data: { fleet: { version: 2, totalActive: 0 } } });
    await harness.flush();
    expect(harness.statuses.length).toBe(before);
    harness.setSubagents(0);
    harness.resumeReplies();
    await harness.tick(3_000);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test('bounds outstanding requests and recovers after timeouts without trusting late replies', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    harness.pauseReplies();
    await harness.tick(3_000);
    const request = harness.requests.at(-1)!;
    const before = harness.requests.length;
    for (let i = 0; i < 5; i++) harness.events.emit('subagent:async-started', {});
    await harness.flush();
    expect(harness.requests.length).toBe(before);
    await harness.tick(2_000);
    const statuses = harness.statuses.length;
    harness.reply(request, harness.statusReply(request, 0));
    await harness.flush();
    expect(harness.statuses.length).toBe(statuses);
    harness.setSubagents(0);
    harness.resumeReplies();
    await harness.tick(1_000);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test('shutdown cancels outstanding RPC, removes listeners and stops polling', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    harness.pauseReplies();
    await harness.tick(3_000);
    const request = harness.requests.at(-1)!;
    await harness.emit('session_shutdown');
    const before = harness.statuses.length;
    const requests = harness.requests.length;
    harness.reply(request, harness.statusReply(request, 2));
    harness.events.emit('subagent:async-started', {});
    await harness.tick(9_000);
    expect(harness.statuses.length).toBe(before);
    expect(harness.statuses.at(-1)).toBe('done');
    expect(harness.requests.length).toBe(requests);
    expect(harness.listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)?.size ?? 0).toBe(0);
  });

  test('shutdown cannot be undone by a settlement waiting for RPC', async () => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    harness.pauseReplies();
    const settlement = harness.emit('agent_settled');
    await harness.emit('session_shutdown');
    await settlement;
    await harness.flush();
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test.each([false, true])('session replacement discards previous activity and uncertainty (%s)', async (uncertain) => {
    const harness = await createHarness(stoppedMessage(), { subagents: 1 });
    harness.pauseReplies();
    if (uncertain) {
      const settlement = harness.emit('agent_settled');
      await harness.tick(2_000);
      await settlement;
    }
    await harness.tick(3_000);
    const old = harness.requests.at(-1)!;
    harness.setSubagents(0);
    harness.resumeReplies();
    await harness.emit('session_start');
    await harness.flush();
    const before = harness.statuses.length;
    harness.reply(old, harness.statusReply(old, 2));
    await harness.flush();
    expect(harness.statuses.length).toBe(before);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test.each(['child', 'disabled'] as const)('does not register or publish from a %s runtime', async (flag) => {
    const harness = await createHarness(stoppedMessage(), { [flag]: true, subagents: 1 });
    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    await harness.tick(6_000);
    await harness.emit('session_shutdown');
    expect(harness.calls).toEqual([]);
    expect(harness.requests).toEqual([]);
  });
});

describe('pi workmux status extension', () => {
  test('registers without changing status when no publisher is present', async () => {
    const harness = await createHarness();
    expect(harness.calls).toEqual([['register-agent']]);
    await harness.emit('session_shutdown');
    expect(harness.statuses).toEqual([]);
  });

  test('reports done only after the full agent run settles', async () => {
    const harness = await createHarness();

    await harness.emit('agent_start');
    await harness.emit('agent_end');
    expect(harness.statuses).toEqual(['working']);

    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test.each(abortedMessages)('stays working after an aborted turn without a publisher', async (message) => {
    const harness = await createHarness(message);

    await harness.emit('agent_start');
    await harness.emit('agent_settled');

    expect(harness.statuses).toEqual(['working']);
  });

  test('reports done after the continuation completes', async () => {
    const harness = await createHarness(abortedMessages[1]);

    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    harness.setMessage(stoppedMessage());
    await harness.emit('agent_start');
    await harness.emit('agent_settled');

    expect(harness.statuses).toEqual(['working', 'working', 'done']);
  });

  test('ordinary errors still report done without a publisher', async () => {
    const harness = await createHarness({
      role: 'assistant', stopReason: 'error', errorMessage: 'Provider unavailable',
    });
    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test.each([0, 2])('requests a restored snapshot after registration (%i children)', async (snapshot) => {
    const harness = await createHarness(stoppedMessage(), { snapshot });
    expect(harness.calls).toEqual([
      ['register-agent'],
      ['set-window-status', snapshot > 0 ? 'working' : 'done'],
    ]);
  });

  test('accepts a publisher starting after the consumer', async () => {
    const harness = await createHarness();
    await harness.activity(2);
    expect(harness.statuses).toEqual(['working']);
  });

  test('restoring children does not hide an already active parent', async () => {
    const harness = await createHarness(stoppedMessage(), { snapshot: 0, idle: false });
    expect(harness.statuses).toEqual(['working']);
  });

  test('keeps working until every concurrent child becomes inactive', async () => {
    const harness = await createHarness();
    await harness.emit('agent_start');
    await harness.activity(2);
    await harness.emit('agent_end');
    await harness.emit('agent_settled');
    await harness.activity(1);
    await harness.activity(1);
    expect(harness.statuses).toEqual(['working']);
    await harness.activity(0);
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('keeps working while the parent runs after the last child stops', async () => {
    const harness = await createHarness();
    await harness.activity(1);
    await harness.emit('agent_start');
    await harness.activity(0);
    await harness.emit('agent_end');
    expect(harness.statuses).toEqual(['working']);
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('does not settle a parent run started by another extension', async () => {
    const harness = await createHarness();
    await harness.emit('agent_start');
    await harness.activity(0);
    await harness.emit('agent_settled', false);
    expect(harness.statuses).toEqual(['working']);
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('waiting children stop contributing and resume without a parent turn', async () => {
    const harness = await createHarness();
    await harness.activity(1);
    await harness.activity(0);
    await harness.activity(1);
    await harness.activity(0);
    expect(harness.statuses).toEqual(['working', 'done', 'working', 'done']);
  });

  test.each(abortedMessages)('keeps aborted continuations working with an authoritative publisher', async (message) => {
    const harness = await createHarness(message);
    await harness.emit('agent_start');
    await harness.activity(1);
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working']);
    await harness.activity(0);
    expect(harness.statuses).toEqual(['working']);
    harness.setMessage(stoppedMessage());
    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('a zero-child snapshot does not interrupt an aborted continuation', async () => {
    const harness = await createHarness(abortedMessages[0]);
    await harness.emit('agent_start');
    await harness.activity(0);
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working']);
  });

  test('ignores malformed snapshots without enabling aggregate behavior', async () => {
    const harness = await createHarness(abortedMessages[0]);
    await harness.emit('agent_start');
    for (const data of [null, undefined, 2, {}, { activeCount: '1' },
      { activeCount: -1 }, { activeCount: 0.5 }, { activeCount: NaN },
      { activeCount: Infinity }, { activeCount: Number.MAX_SAFE_INTEGER + 1 }]) {
      harness.events.emit('suba:activity', data);
    }
    await harness.flush();
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working']);
  });

  test('serializes overlapping child and parent status commands', async () => {
    const gate = deferred();
    const started = deferred();
    const harness = await createHarness(stoppedMessage(), {
      async exec(args) {
        if (args[1] === 'working') {
          started.resolve();
          await gate.promise;
        }
        return 0;
      },
    });
    harness.events.emit('suba:activity', { activeCount: 1 });
    await started.promise;
    harness.events.emit('suba:activity', { activeCount: 0 });
    const parentStart = harness.emit('agent_start');
    expect(harness.calls).toEqual([['register-agent'], ['set-window-status', 'working']]);
    gate.resolve();
    await parentStart;
    await harness.flush();
    expect(harness.statuses).toEqual(['working', 'done', 'working']);
  });

  test.each(['reject', 'nonzero'])('a %s command failure does not poison later writes', async (failure) => {
    let attempts = 0;
    const harness = await createHarness(stoppedMessage(), {
      async exec(args) {
        if (args[0] === 'set-window-status' && attempts++ === 0) {
          if (failure === 'reject') throw new Error('workmux unavailable');
          return 1;
        }
        return 0;
      },
    });
    await harness.activity(1);
    await harness.activity(1);
    await harness.activity(0);
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('registration failure does not prevent status updates', async () => {
    const harness = await createHarness(stoppedMessage(), {
      async exec(args) {
        if (args[0] === 'register-agent') throw new Error('not in tmux');
        return 0;
      },
    });
    await harness.activity(1);
    await harness.activity(0);
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('shutdown drains pending writes, clears activity, and removes its listener', async () => {
    const gate = deferred();
    const started = deferred();
    const harness = await createHarness(stoppedMessage(), {
      async exec(args) {
        if (args[1] === 'working') {
          started.resolve();
          await gate.promise;
        }
        return 0;
      },
    });
    harness.events.emit('suba:activity', { activeCount: 1 });
    await started.promise;
    let stopped = false;
    const shutdown = harness.emit('session_shutdown').then(() => { stopped = true; });
    await harness.emit('agent_start');
    harness.events.emit('suba:activity', { activeCount: 2 });
    expect(stopped).toBe(false);
    expect(harness.listeners.get('suba:activity')!.size).toBe(0);
    gate.resolve();
    await shutdown;
    await harness.flush();
    await harness.emit('session_shutdown');
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('session replacement discards child counts and ordinary abort behavior returns', async () => {
    const harness = await createHarness(abortedMessages[0], { snapshot: 2 });
    await harness.emit('session_shutdown');
    harness.stopPublisher();
    await harness.emit('session_start');
    await harness.emit('agent_start');
    await harness.emit('agent_settled');
    expect(harness.statuses).toEqual(['working', 'done', 'working']);
    expect(harness.listeners.get('suba:activity')!.size).toBe(1);
  });

  test('reload requests a fresh snapshot and does not accumulate listeners', async () => {
    const harness = await createHarness(stoppedMessage(), { snapshot: 2 });
    await harness.emit('session_shutdown');
    await harness.emit('session_start');
    expect(harness.statuses).toEqual(['working', 'done', 'working']);
    expect(harness.listeners.get('suba:activity')!.size).toBe(1);
    await harness.activity(0);
    expect(harness.statuses.at(-1)).toBe('done');
  });

  test('sends a submitted prompt with the agent start report', async () => {
    const harness = await createHarness();

    await harness.input('fix the bug', 'interactive', '/repo/feature');
    expect(spawned).toEqual([]);
    await harness.emit('agent_start');
    await harness.emit('agent_settled');

    expect(spawned).toEqual([
      { args: ['set-window-status', 'working'], cwd: '/repo/feature', prompt: 'fix the bug' },
    ]);
    expect(harness.statuses).toEqual(['working', 'done']);
  });

  test('sends a steering prompt at once while the agent works', async () => {
    const harness = await createHarness(stoppedMessage(), { snapshot: 0 });

    await harness.emit('agent_start');
    await harness.input('also update docs');

    expect(spawned.map((record) => record.prompt)).toEqual(['also update docs']);
    expect(harness.statuses).toEqual(['done', 'working', 'working']);
  });

  test('does not report working for a prompt while nothing is active', async () => {
    const gate = deferred();
    const harness = await createHarness(stoppedMessage(), {
      async exec(args) {
        if (args[1] === 'done') await gate.promise;
        return 0;
      },
    });
    await harness.activity(1);
    harness.events.emit('suba:activity', { activeCount: 0 });
    await harness.input('next task');
    gate.resolve();
    await harness.flush();

    expect(harness.statuses).toEqual(['working', 'done']);
    expect(spawned).toEqual([]);
  });

  test('ignores extension-sourced and blank input', async () => {
    const harness = await createHarness();

    await harness.input('injected', 'extension');
    await harness.input('  ');
    await harness.emit('agent_start');

    expect(spawned).toEqual([]);
    expect(harness.statuses).toEqual(['working']);
  });

  test.each(['error', 'throw', 1] as const)('a %s prompt write does not poison later writes', async (failure) => {
    const harness = await createHarness(stoppedMessage(), { snapshot: 0 });

    spawnResult = failure;
    await harness.input('fix the bug');
    await harness.emit('agent_start');
    spawnResult = 0;
    await harness.emit('agent_settled');
    await harness.activity(1);

    expect(harness.statuses).toEqual(['done', 'done', 'working']);
  });
});
