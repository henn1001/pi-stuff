import type { Origin } from "./member.ts";

/** Identity of the running session. Pi's session ID is authoritative; the member marker is only startup evidence. */
export type Role =
  | { kind: "dormant" }
  | { kind: "lead"; sessionId: string; workspaceId: string; projectCwd: string }
  | {
      kind: "member";
      workspaceId: string;
      sessionId: string;
      /** Display-only pane title. */
      title: string;
      agent: string;
      /** Independent members without a selected definition use the built-in interactive default. */
      defaultDefinition?: boolean;
      origin: "tool" | "menu";
      /** Original caller's pi session ID. */
      caller: string;
      /** Lead's project cwd, so nested spawns see the same catalog. */
      projectCwd: string;
      /** Present when the process marker exists but its startup handoff is incomplete. */
      metadataError?: string;
    };

/**
 * Runtime projection. Roles, assignments and pane takeover restore from the workspace
 * ledger by session/instance ID, never from the selected conversation branch.
 */
export interface CrewState {
  role: Role;
  /** Lead only: durable activation is held by this runtime. */
  enabled: boolean;
  /** Pi session IDs of delegated children whose final result / exit hasn't been observed. */
  outstanding: Set<string>;
  /** Volatile child report/exit observations, registered before launch release. */
  children: Map<string, { agent: string; origin: Origin; reported: boolean; exited: boolean }>;
  /** Runtime-confirmed abortion disables automatic completion for this pane lifetime. */
  takeover: boolean;
  /** Whether the current member definition allows leaf delegation. */
  memberSpawning: boolean;
}

/** Create an inactive projection before restoring any session-wide SQLite authority. */
export function createState(): CrewState {
  return {
    role: { kind: "dormant" },
    enabled: false,
    outstanding: new Set(),
    children: new Map(),
    takeover: false,
    memberSpawning: false,
  };
}