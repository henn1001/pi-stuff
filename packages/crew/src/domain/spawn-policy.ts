/** Facts that decide whether a session may spawn; gathered by the caller from the ledger. */
export interface SpawnFacts {
  /** Distance to the lead, or undefined when the recorded tree is broken. */
  depth: number | undefined;
  isLead: boolean;
  /** Member definition enables delegation. */
  memberSpawning: boolean;
  /** Attachment to the recorded parent is ready (or there is no parent). */
  parentReady: boolean;
}

/** Deepest tree level that may still spawn. */
const MAX_SPAWN_DEPTH = 2;

/** Role, delegation permission, tree depth and attachment readiness. */
export function maySpawn(facts: SpawnFacts): boolean {
  return (
    facts.depth !== undefined &&
    facts.depth < MAX_SPAWN_DEPTH &&
    (facts.isLead || facts.memberSpawning) &&
    facts.parentReady
  );
}

/** Automatic lifecycle mode only admits definitions that exit automatically. */
export function lifecycleModeDisallows(
  automatic: boolean,
  definition: { autoExit: boolean } | undefined,
): boolean {
  return Boolean(definition && automatic && !definition.autoExit);
}