/**
 * The collector with every harness adapter this machine can use. OpenCode's adapter opens its database lazily, so a
 * Claude-only machine never touches it; a Node without `node:sqlite` simply has no OpenCode adapter.
 */
import type { Adapter, Collector, Harness } from "./metrics.ts";
import { stateDir } from "./metrics.ts";
import { claudeAdapter } from "./metrics-claude.ts";
import { openCodeAdapter } from "./metrics-opencode.ts";

export async function collector(dir = stateDir()): Promise<Collector> {
  const adapters: Partial<Record<Harness, Adapter>> = { "claude-code": claudeAdapter() };
  try {
    adapters.opencode = await openCodeAdapter();
  } catch {
    // no node:sqlite – OpenCode runs are kept as markers (time only) until a newer Node collects them
  }
  return { adapters, dir };
}
