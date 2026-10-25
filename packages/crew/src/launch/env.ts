/** Startup handoff fields set by the launcher; the actual identity always comes from pi. */
export const ENV_CREW_AGENT = "PI_CREW_AGENT";
export const ENV_CREW_ORIGIN = "PI_CREW_ORIGIN";
export const ENV_CREW_CALLER = "PI_CREW_CALLER";
export const ENV_CREW_PROJECT_CWD = "PI_CREW_PROJECT_CWD";
/** Set by the running member after startup to reject stale inherited member markers on forks. */
export const ENV_CREW_SESSION_ID = "PI_CREW_SESSION_ID";

/** Member marker set on spawned processes; identity comes from pi, not this env var. */
export const ENV_SUBAGENT_ID = "PI_SUBAGENT_ID";