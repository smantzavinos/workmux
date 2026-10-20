import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test driver only: spawn real native children through the public RPC, never
// synthesize activity counts or call the workmux status extension directly.
export default function (pi: ExtensionAPI) {
  const root = process.env.WORKMUX_SMOKE_ROOT!;
  const runs: string[] = [];
  let stopping = false;
  let polling = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  function record(data: object) {
    appendFileSync(`${root}/controller.jsonl`, JSON.stringify({ at: Date.now() / 1000, ...data }) + "\n");
  }

  function rpc(method: string, params?: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`RPC timeout: ${method}`));
      }, 12_000);
      const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
        const reply = raw as { success: boolean; data?: unknown; error?: unknown };
        clearTimeout(timeout);
        unsubscribe();
        if (reply.success) resolve(reply.data);
        else reject(new Error(JSON.stringify(reply.error)));
      });
      pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
    });
  }

  async function stopRuns() {
    stopping = true;
    if (interval) clearInterval(interval);
    // Already-terminal targets are rejected by the owner; cleanup is idempotent.
    await Promise.allSettled(runs.map((id) => rpc("stop", { id })));
    writeFileSync(`${root}/cleanup.complete`, "ok");
  }

  pi.registerCommand("workmux-smoke-stop", {
    description: "Stop only the native children owned by this disposable smoke test",
    handler: stopRuns,
  });

  pi.on("agent_settled", (_event, ctx) => {
    record({ phase: "parent-settled", idle: ctx.isIdle() });
  });

  pi.on("session_start", () => {
    setTimeout(async () => {
      try {
        const ping = await rpc("ping");
        if (ping.capabilities?.fleetStatus?.version !== 1) throw new Error("pi-subagents needs fleet status v1");
        for (const task of ["SMOKE_SLOW", "SMOKE_FAIL", "SMOKE_STOP"]) {
          if (stopping) return;
          const run = await rpc("spawn", { agent: "smoke-native", task, async: true, agentScope: "user" });
          runs.push(run.details.runId);
          record({ phase: "spawn", id: run.details.runId, task });
          if (stopping) { await stopRuns(); return; }
        }
        setTimeout(() => {
          if (!stopping) void rpc("stop", { id: runs[2] }).catch((error) => record({ phase: "error", error: String(error) }));
        }, 10_000);
        writeFileSync(`${root}/launched`, "ok");
        interval = setInterval(async () => {
          if (polling || stopping) return;
          polling = true;
          try {
            const data = await rpc("status");
            record({ phase: "fleet", fleet: data.fleet });
          } catch (error) {
            record({ phase: "error", error: String(error) });
          } finally {
            polling = false;
          }
        }, 1_000);
      } catch (error) {
        record({ phase: "error", error: String(error) });
      }
    }, 500);
  });

  pi.on("session_shutdown", () => {
    stopping = true;
    if (interval) clearInterval(interval);
  });
}
