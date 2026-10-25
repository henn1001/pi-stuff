import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewState } from "./state.ts";
import type { Poller } from "../transport/registry.ts";
import type { SocketServer } from "../transport/socket.ts";
import type { AgentDefinition } from "./types.ts";

//TODO: review if all properties are needed/used
/** Per-extension-instance runtime shared by tools, command, lifecycle, and UI. */
export interface CrewContext {
  pi: ExtensionAPI;
  state: CrewState;
  /** Startup authority failure blocks later activation in this runtime too. */
  authorityError?: string;
  ledger?: import("./ledger.ts").Ledger;
  ownership?: import("./ownership.ts").Ownership;
  ledgerSnapshot?: ReturnType<import("./ledger.ts").Ledger["restore"]>;
  sessionContext?: ExtensionContext;
  refreshSupervision?: () => void;
  supervisionError?: string;
  processes: Map<string, import("./process-identity.ts").ProcessPresence>;
  /** Local submission/evidence adapter; never owns command execution. */
  execution?: import("./execution.ts").Execution;
  /** Present only in the recorded lead process. */
  coordinator?: import("./coordinator.ts").Coordinator;
  attachment?: import("./attachment.ts").Attachment;
  working: boolean;
  run?: import("./lifecycle.ts").CompletionRun;
  /** Invalidates asynchronous work on runtime or session replacement, not branch navigation. */
  epoch: number;
  /** Last verified workspace lead identity, retained through disconnects. */
  knownLeadId?: string;
  /** Definition snapshot selected at launch or resume. */
  memberDefinition?: import("./types.ts").AgentDefinition;
  /** Agent definitions loaded once per extension runtime, used by every launch path. */
  definitions: Map<string, AgentDefinition>;
  server?: SocketServer;
  poller?: Poller;
  /** Reconcile resources after role/enabled changes; installed by resources.ts at startup. */
  syncResources?: () => Promise<void>;
  /** Cancel polling and close this session's server before replacing its identity. */
  closeResources?: () => Promise<void>;
  /** Latest shared workspace discovery snapshot for tools and views. */
  connections?: import("../transport/registry.ts").ConnectionSnapshot;
  /** Display observers share the resource manager's discovery pass. */
  connectionObservers: Set<() => void>;
  /** Close session-bound dialogs before resource/identity replacement. */
  closeViews: Set<() => void>;
}

export function createCrewContext(pi: ExtensionAPI, state: CrewState): CrewContext {
  return {
    pi,
    state,
    working: false,
    epoch: 0,
    processes: new Map(),
    definitions: new Map(),
    connectionObservers: new Set(),
    closeViews: new Set(),
  };
}

/** Whether this process has the Herdr caller context required by Crew. */
export function hasHerdrContext(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    Boolean(process.env.HERDR_WORKSPACE_ID) &&
    Boolean(process.env.HERDR_PANE_ID)
  );
}