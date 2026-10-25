/** Custom conversation message type; conversation entries never confer Crew authority. */
export const MESSAGE_TYPE = "crew";

/** Durable routing identity; labels are presentation only. */
export interface CrewMessageDetails {
  from: string;
  to: string;
  fromLabel?: string;
  toLabel?: string;
  kind: "message" | "result" | "disconnect";
  /** Private durable delivery correlation, excluded from model-visible content. */
  requestId?: string;
}