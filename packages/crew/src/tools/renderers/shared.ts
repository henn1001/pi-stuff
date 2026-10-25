import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Pi renderer signatures, kept outside model-facing tool results. */
type RenderCall = NonNullable<ToolDefinition<any, any>["renderCall"]>;
/** Pi result-renderer callback. */
type RenderResult = NonNullable<ToolDefinition<any, any>["renderResult"]>;
/** Active theme supplied by Pi. */
type RenderCallTheme = Parameters<RenderCall>[1];
/** Call expansion and execution state supplied by Pi. */
type RenderCallContext = Parameters<RenderCall>[2];
/** Terminal component returned to Pi. */
type RenderCallComponent = ReturnType<RenderCall>;

/** Compact human-only call preview; expansion preserves the complete arguments. */
export function renderPromptCall(
  content: string | undefined,
  action: string,
  target: string | undefined,
  theme: RenderCallTheme,
  context: RenderCallContext,
): RenderCallComponent {
  return {
    invalidate() {},
    render(width: number) {
      const header =
        theme.fg("accent", "▸") +
        " " +
        theme.fg("toolTitle", theme.bold(action)) +
        (target ? theme.fg("dim", ` · ${target}`) : "");
      if (!context.expanded) {
        const preview = content?.split("\n").find((line) => line.trim());
        return [truncateToWidth(header + (preview ? ` · ${preview}` : ""), width)];
      }
      return [
        ...wrapTextWithAnsi(header, Math.max(1, width)),
        ...wrapTextWithAnsi(content ?? "", Math.max(1, width)).map((line) =>
          theme.fg("toolOutput", line),
        ),
      ];
    },
  };
}

/** Present success semantics without changing the JSON returned through the originating tool. */
export function renderToolResult(summary: string): RenderResult {
  return (result, options, theme, context) => ({
    invalidate() {},
    render(width: number) {
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const color = context.isError ? "error" : "dim";
      const heading = context.isError ? "Failed" : options.isPartial ? "Pending" : summary;
      return context.expanded
        ? wrapTextWithAnsi(`${heading}\n${text}`, Math.max(1, width)).map((line) =>
            theme.fg(color, line),
          )
        : [truncateToWidth(theme.fg(color, `${heading} · ${text.replaceAll("\n", " ")}`), width)];
    },
  });
}