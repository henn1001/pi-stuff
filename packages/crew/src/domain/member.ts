/** Who started an agent. `tool`: a model called `spawn_agent` with a task. `menu`: the user, idle, no task. */
export type Origin = "tool" | "menu";

/** Saved child identity and conversation location used for explicit resume. */
export interface SpawnRecord {
  /** Pi session ID; preserved on resume. */
  sessionId: string;
  agent: string;
  origin: Origin;
  /** Original caller's pi session ID. */
  caller: string;
  sessionFile: string;
}

/** Launcher-provided member identity, bound to the actual Pi session before registration. */
export interface MemberMetadata {
  version: 1;
  /** Pi session ID; prevents a fork from adopting its source member's relationship. */
  sessionId: string;
  agent: string;
  origin: Origin;
  /** Original caller's full pi session ID. */
  caller: string;
  /** Project cwd inherited from the workspace lead, used as the nested catalog anchor. */
  projectCwd: string;
}