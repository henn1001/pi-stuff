/** Identity and task-name syntax. */

export function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) &&
    value !== "lead" &&
    value !== "caller"
  );
}

/** Full Pi session identity; prefixes and trailing line terminators are not identities. */
export function isAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i.test(value)
  );
}

/** Parent-local aliases exclude canonical UUID session identities and reject surrounding whitespace. */
export function isTaskName(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(value) && !isAgentId(value)
  );
}