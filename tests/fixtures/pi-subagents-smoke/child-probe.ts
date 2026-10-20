import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    appendFileSync(`${process.env.WORKMUX_SMOKE_ROOT}/children.jsonl`, JSON.stringify({
      child: process.env.PI_SUBAGENT_CHILD,
      pid: process.pid,
      pane: process.env.TMUX_PANE,
    }) + "\n");
  });
}
