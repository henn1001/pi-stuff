import { resolve } from "node:path";

let configured: string | undefined;

/** Record pi's resolved agent directory once at extension load; leaf layers never import pi. */
export function setAgentDir(dir: string): void {
  configured = resolve(dir);
}

/** Pi's resolved agent directory, as recorded by `setAgentDir`. */
export function agentDir(): string {
  if (!configured) {
    throw new Error("Crew agent directory is not configured.");
  }
  return configured;
}