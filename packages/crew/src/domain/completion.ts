/** Structural view of an assistant message; keeps the domain free of pi types. */
export interface ReportSource {
  content: ReadonlyArray<{ type: string; text?: string }>;
}

/** Select only the supplied current-run message; never search history. */
export function selectReport(message: ReportSource | undefined): string | undefined {
  const text = message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return text?.trim() ? text : undefined;
}