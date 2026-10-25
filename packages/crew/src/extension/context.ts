import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../domain/agent.ts";
import type { CrewState } from "../domain/role.ts";
import type { Poller, ConnectionSnapshot } from "../ipc/registry.ts";
import type { SocketServer } from "../ipc/socket.ts";
import type { Attachment } from "../local/attachment.ts";
import type { Execution } from "../local/execution.ts";
import type { CompletionRun } from "../local/lifecycle.ts";
import type { LocalStore } from "../store/local-store.ts";
import type { Ownership } from "../store/ownership.ts";
import type { ProcessPresence } from "../store/process-identity.ts";

/**
 * State and services every Crew role reads: session identity, definitions, display plumbing and
 * resource lifecycle hooks. Created once per extension instance and never replaced.
 */
export interface SharedContext {
  pi: ExtensionAPI;
  /** Role, enablement and session-wide flags for this process. */
  state: CrewState;
  /** Startup authority failure blocks later activation in this runtime too. */
  authorityError?: string;
  /** Pi context of the live session; absent between session shutdown and the next start. */
  sessionContext?: ExtensionContext;
  /** Exact-instance process presence from the latest observation pass, keyed by instance id. */
  processes: Map<string, ProcessPresence>;
  /** Invalidates asynchronous work on runtime or session replacement, not branch navigation. */
  epoch: number;
  /** Agent definitions loaded once per extension runtime, used by every launch path. */
  definitions: Map<string, AgentDefinition>;
  /** Latest shared workspace discovery snapshot for tools and views. */
  connections?: ConnectionSnapshot;
  /** Display observers share the resource manager's discovery pass. */
  connectionObservers: Set<() => void>;
  /** Close session-bound dialogs before resource/identity replacement. */
  closeViews: Set<() => void>;
  /** Reconcile resources after role/enabled changes; installed by resources.ts at startup. */
  syncResources?: () => Promise<void>;
  /** Cancel polling and close this session's server before replacing its identity. */
  closeResources?: () => Promise<void>;
}

/**
 * Adapters present in every active Crew process, lead included. They persist through SQLite and
 * reach the coordinator only via IPC wake-ups, never through a coordinator reference.
 */
export interface LocalContext {
  /** Local write facade; set once authority is claimed, cleared when it is released. */
  ledger?: LocalStore;
  /** OS-level ownership of this session instance, paired with `ledger`. */
  ownership?: Ownership;
  /** Local submission/evidence adapter; never owns command execution. */
  execution?: Execution;
  /** Child-to-parent attachment handshake and reconciliation for this session. */
  attachment?: Attachment;
  /** Logical run that is in flight for completion reporting, if any. */
  run?: CompletionRun;
  /** Triggers an immediate observation pass; installed by the observer while it runs. */
  refreshSupervision?: () => void;
  /** Definition snapshot selected at launch or resume. */
  memberDefinition?: AgentDefinition;
  /** Shared discovery and observation poller for this runtime. */
  poller?: Poller;
  /** Unix socket server that receives wake-ups and attachment requests for this session. */
  server?: SocketServer;
  /**
   * Wakes the lead's coordinator queue. Installed by resources.ts only in the lead process; local
   * code calls it without knowing a coordinator exists.
   */
  wakeCoordinator?: () => void;
}

/** What tools, commands, hooks, views and `local/` code receive: shared plus local parts. */
export type CrewContext = SharedContext & LocalContext;

/** Create the empty shared and local parts; resources.ts fills them as authority is claimed. */
export function createCrewContext(pi: ExtensionAPI, state: CrewState): CrewContext {
  return {
    pi,
    state,
    epoch: 0,
    processes: new Map(),
    definitions: new Map(),
    connectionObservers: new Set(),
    closeViews: new Set(),
  };
}