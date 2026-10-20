/**
 * Workmux status tracking extension for pi.
 *
 * Reports agent status to workmux for tmux window status display.
 * See: https://workmux.raine.dev/guide/status-tracking
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AssistantState = { stopReason?: string; errorMessage?: string };
type PendingPrompt = { text: string; cwd: string };

const SUBAGENTS_RPC = "subagents:rpc:v1";
const POLL_MS = 3_000; // Below the sidebar's 10-second inactivity timeout.
const RPC_TIMEOUT_MS = 2_000;
const DISCOVERY_BACKOFF_MS = [3_000, 15_000];

type StatusRequest = {
  requestId: string;
  revision: number;
  heartbeat: boolean;
  unsubscribe: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// pi-subagents is optional and independently installed. Use its public event-bus
// RPC, not package imports, child files, or the bounded fleet.entries window.
function trackSubagents(
  pi: ExtensionAPI,
  onActivity: (count: number, heartbeat: boolean) => Promise<void>,
) {
  let disposed = false;
  let available = false;
  let uncertain = false;
  let revision = 0;
  let pending: StatusRequest | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let discovery: ReturnType<typeof setTimeout> | undefined;
  let discoveryAttempt = 0;
  const waiters = new Set<(fresh: boolean) => void>();

  function finishRequest() {
    const request = pending;
    if (request) {
      pending = undefined;
      clearTimeout(request.timeout);
      request.unsubscribe();
    }
    return request;
  }

  function finishWaiters(fresh: boolean) {
    for (const finish of [...waiters]) finish(fresh);
  }

  function scheduleDiscovery() {
    if (disposed || available || discovery || discoveryAttempt >= DISCOVERY_BACKOFF_MS.length) return;
    discovery = setTimeout(() => {
      discovery = undefined;
      requestStatus();
    }, DISCOVERY_BACKOFF_MS[discoveryAttempt++]);
    discovery.unref();
  }

  function requestStatus(heartbeat = false) {
    if (disposed) return;
    if (pending) {
      pending.heartbeat ||= heartbeat;
      return;
    }
    if (discovery) clearTimeout(discovery);
    discovery = undefined;
    const requestId = randomUUID();
    const unsubscribe = pi.events.on(`${SUBAGENTS_RPC}:reply:${requestId}`, (reply) => {
      if (disposed || pending?.requestId !== requestId || !isRecord(reply) ||
          reply.version !== 1 || reply.requestId !== requestId) return;
      const request = finishRequest();
      if (!request) return;
      // Re-read superseded snapshots, but never extend settlement's deadline.
      if (request.revision !== revision) {
        requestStatus(request.heartbeat);
        return;
      }
      const fleet = reply.success === true && isRecord(reply.data) ? reply.data.fleet : undefined;
      if (!isRecord(fleet) || fleet.version !== 1 || typeof fleet.totalActive !== "number" ||
          !Number.isSafeInteger(fleet.totalActive) || fleet.totalActive < 0) {
        finishWaiters(false);
        scheduleDiscovery();
        return;
      }
      available = true;
      uncertain = false;
      // No recurring polling until a compatible owner has actually replied.
      if (!interval) {
        interval = setInterval(() => requestStatus(true), POLL_MS);
        interval.unref();
      }
      const report = onActivity(fleet.totalActive, request.heartbeat);
      finishWaiters(true);
      return report;
    });
    const timeout = setTimeout(() => {
      if (pending?.requestId !== requestId) return;
      finishRequest();
      finishWaiters(false);
      scheduleDiscovery();
    }, RPC_TIMEOUT_MS);
    timeout.unref();
    pending = { requestId, revision, heartbeat, unsubscribe, timeout };
    pi.events.emit(`${SUBAGENTS_RPC}:request`, { version: 1, requestId, method: "status" });
  }

  const subscriptions = [
    pi.events.on(`${SUBAGENTS_RPC}:ready`, () => {
      // Discovery may have preceded the owner's registration or been exhausted.
      finishRequest();
      discoveryAttempt = 0;
      revision++;
      requestStatus();
    }),
    ...["subagent:async-started", "subagent:async-complete"].map((event) =>
      pi.events.on(event, () => { revision++; requestStatus(); })),
  ];
  requestStatus();
  return {
    get available() { return available; },
    get uncertain() { return uncertain; },
    refresh: () => new Promise<void>((resolve) => {
      if (disposed) return resolve();
      function finish(fresh: boolean) {
        clearTimeout(deadline);
        waiters.delete(finish);
        if (!fresh && !disposed) uncertain = true;
        resolve();
      }
      // This budget belongs to the caller, not each retry in a request chain.
      const deadline = setTimeout(() => finish(false), RPC_TIMEOUT_MS);
      deadline.unref();
      waiters.add(finish);
      revision++;
      requestStatus();
    }),
    dispose() {
      disposed = true;
      if (interval) clearInterval(interval);
      if (discovery) clearTimeout(discovery);
      finishRequest();
      finishWaiters(false);
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}

// `pi.exec` cannot write to stdin, so prompt-carrying reports spawn directly.
// Like `pi.exec`, this resolves with an exit code and never throws.
function execWithPrompt(args: string[], prompt: PendingPrompt): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawn("workmux", args, {
        cwd: prompt.cwd,
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ prompt: prompt.text }));
    } catch {
      resolve(1);
    }
  });
}

export default function (pi: ExtensionAPI) {
  // Background pi-subagents sessions load ambient extensions and inherit the
  // parent's pane. Only the parent may register or report aggregate status.
  if (process.env.PI_SUBAGENT_CHILD === "1" ||
      process.env.WORKMUX_DISABLE_SET_WINDOW_STATUS !== undefined) return;

  let sessionActive = false;
  let generation = 0;
  let parentWorking = false;
  let activeCount: number | undefined;
  let subagentsCount: number | undefined;
  let subagents: ReturnType<typeof trackSubagents> | undefined;
  let unsubscribe: (() => void) | undefined;
  let writes = Promise.resolve();
  let lastStatus: string | undefined;
  let pendingPrompt: PendingPrompt | undefined;
  let heartbeatQueued = false;

  function hasActivity() {
    return activeCount !== undefined || subagentsCount !== undefined;
  }

  function setStatus(status: string, heartbeat = false) {
    // A slow CLI must not accumulate periodic writes ahead of a final `done`.
    if (heartbeat && heartbeatQueued && !pendingPrompt) return writes;
    if (heartbeat) heartbeatQueued = true;
    const deduplicate = hasActivity();
    // A pending prompt rides the next `working` report, even a repeated one.
    const prompt = status === "working" ? pendingPrompt : undefined;
    if (prompt) pendingPrompt = undefined;
    // Event bus callbacks are not awaited by pi. Serialize external writes so an
    // older command cannot finish after a newer status and overwrite it.
    writes = writes.then(async () => {
      if (deduplicate && status === lastStatus && !prompt && !heartbeat) return;
      const args = ["set-window-status", status];
      try {
        const code = prompt
          ? await execWithPrompt(args, prompt)
          : (await pi.exec("workmux", args)).code;
        lastStatus = code === 0 ? status : undefined;
      } catch {
        lastStatus = undefined;
      } finally {
        if (heartbeat) heartbeatQueued = false;
      }
    });
    return writes;
  }

  function isWorking() {
    return parentWorking || (activeCount ?? 0) > 0 || (subagentsCount ?? 0) > 0 ||
      (subagents?.uncertain ?? false);
  }

  function reportActivity(heartbeat = false) {
    return setStatus(isWorking() ? "working" : "done", heartbeat);
  }

  function latestAssistantWasAborted(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type?: string;
      message?: AssistantState & { role?: string };
    }>;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "message" || entry.message?.role !== "assistant") {
        continue;
      }
      return (
        entry.message.stopReason === "aborted" ||
        (entry.message.stopReason === "error" &&
          /\boperation was aborted\b/i.test(entry.message.errorMessage ?? ""))
      );
    }
    return false;
  }

  pi.on("session_start", async (_event, ctx) => {
    const current = ++generation;
    unsubscribe?.();
    subagents?.dispose();
    subagents = undefined;
    sessionActive = false;
    await writes;
    if (generation !== current) return;
    activeCount = undefined;
    subagentsCount = undefined;
    lastStatus = undefined;
    pendingPrompt = undefined;
    parentWorking = !ctx.isIdle();
    await pi.exec("workmux", ["register-agent"]).catch(() => {});
    if (generation !== current) return;
    sessionActive = true;
    unsubscribe = pi.events.on("suba:activity", (data) => {
      if (!sessionActive || !data || typeof data !== "object") return;
      const count = (data as { activeCount?: unknown }).activeCount;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return;
      activeCount = count;
      return reportActivity();
    });
    subagents = trackSubagents(pi, (count, heartbeat) => {
      subagentsCount = count;
      // Heartbeat only freshly validated live work. Failed/missing replies keep
      // the last count but cannot keep a quiet pane artificially alive forever.
      return reportActivity(heartbeat && count > 0);
    });
    // The publisher may have restored children before this handler subscribed.
    pi.events.emit("suba:activity:request", {});
    await writes;
  });

  pi.on("input", async (event, ctx) => {
    if (!sessionActive || event.source === "extension" || !event.text.trim()) return;
    pendingPrompt = { text: event.text, cwd: ctx.cwd };
    // Steering and follow-up messages are handled inside the running agent
    // loop, which starts no new `agent_start`.
    if (isWorking()) await setStatus("working");
  });

  pi.on("agent_start", async () => {
    if (!sessionActive) return;
    parentWorking = true;
    await setStatus("working");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!sessionActive) return;
    const current = generation;
    const wasAborted = latestAssistantWasAborted(ctx);
    parentWorking = !ctx.isIdle() || wasAborted;
    // Catch a child launched since the previous poll before reporting done.
    // With no compatible owner, ordinary Pi settlement never waits for RPC.
    if (subagents?.available) await subagents.refresh();
    if (!sessionActive || generation !== current) return;
    if (hasActivity()) {
      await reportActivity();
    } else if (!wasAborted) {
      await setStatus("done");
    }
  });

  pi.on("session_shutdown", async () => {
    generation++;
    unsubscribe?.();
    unsubscribe = undefined;
    subagents?.dispose();
    subagents = undefined;
    const wasActive = sessionActive;
    sessionActive = false;
    if (wasActive && hasActivity()) await setStatus("done");
    await writes;
  });
}
