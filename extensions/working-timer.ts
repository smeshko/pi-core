/**
 * Working Timer Extension
 *
 * Replaces pi's default spinner with a rainbow-colored animated spinner
 * and appends a grey elapsed-time counter.
 *
 * Pi always renders " Working..." after the frames, so the full line is:
 *   ⠼ 7s Working...
 *   [rainbow] [grey]
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RESET    = "\x1b[0m";
const RESET_FG = "\x1b[39m";
const RED      = "\x1b[38;2;220;50;50m";

const RAINBOW = [
  "\x1b[38;2;255;80;80m",   // bright red
  "\x1b[38;2;220;50;50m",   // mid red
  "\x1b[38;2;180;30;30m",   // dark red
  "\x1b[38;2;255;100;100m", // light red
  "\x1b[38;2;200;40;40m",   // deep red
  "\x1b[38;2;255;60;60m",   // vivid red
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export default function (pi: ExtensionAPI) {
  let handle: ReturnType<typeof setInterval> | null = null;
  let startTime: number | null = null;
  let tick = 0;

  function push(ctx: ExtensionContext): void {
    if (startTime === null) return;
    const color  = RAINBOW[tick % RAINBOW.length]!;
    const frame  = SPINNER[tick % SPINNER.length]!;
    const elapsed = formatElapsed(Date.now() - startTime);
    tick++;
    ctx.ui.setWorkingIndicator({
      frames: [`${color}${frame}${RESET_FG} ${RED}${elapsed}${RESET}`],
    });
  }

  function stop(ctx?: ExtensionContext): void {
    if (handle !== null) { clearInterval(handle); handle = null; }
    startTime = null;
    tick = 0;
    ctx?.ui.setWorkingIndicator();
  }

  pi.on("agent_start", async (_event, ctx) => {
    if (startTime !== null) return; // retry — keep clock running
    startTime = Date.now();
    push(ctx);
    handle = setInterval(() => push(ctx), 80);
  });

  pi.on("agent_settled", async (_event, ctx) => stop(ctx));
  pi.on("session_shutdown", async () => stop());
}
