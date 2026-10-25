import type { Coordinator } from "../coordinator/coordinator.ts";
import type { CoordinatorStore } from "../store/coordinator-store.ts";
import type { CrewContext } from "./context.ts";

/**
 * Lead-only part. Exists only while this process is the recorded lead and runs a coordinator, so
 * `coordinator/` code never checks for absence. `local/` code must not import this type.
 */
export interface CoordinatorContext {
  /** Shared and local parts of the same runtime. */
  readonly crew: CrewContext;
  /** Coordinator write facade over the local connection. */
  readonly coordinatorStore: CoordinatorStore;
  /** Serialized queue that owns every Herdr command and delivery transition. */
  readonly coordinator: Coordinator;
}