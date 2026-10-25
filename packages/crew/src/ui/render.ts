import { keyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CrewMessageDetails } from "../transport/messaging.ts";
import type { CrewContext } from "../runtime/context.ts";

/** Resolve display labels only while rendering; stored payloads and model context remain unchanged. */
export function createCrewMessageRenderer(crew: CrewContext): MessageRenderer<CrewMessageDetails> {
  return (message, options, theme) => ({
    invalidate() {},
    render(width: number) {
      const details = message.details;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");

      const style = (line: string) => {
        const fitted = truncateToWidth(line, width);
        return theme.bg(
          "customMessageBg",
          fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))),
        );
      };

      if (details?.kind === "disconnect") {
        return [style(theme.fg("dim", text.replaceAll("\n", " ")))];
      }

      const label = (id: string | undefined) => {
        if (!id) {
          return "agent";
        }
        const live = crew.connections?.agents.find((agent) => agent.sessionId === id);
        const role = crew.ledger?.role(id);
        return (
          live?.title ??
          (role?.kind === "member" ? role.title : role?.kind === "lead" ? "lead" : id)
        );
      };
      const from = details?.fromLabel ?? label(details?.from);
      const to = details?.toLabel ?? label(details?.to);
      const isResult = details?.kind === "result";
      const header =
        theme.fg(isResult ? "success" : "accent", isResult ? "✓" : "→") +
        " " +
        theme.fg("toolTitle", theme.bold(`${from} → ${to}`)) +
        theme.fg("dim", isResult ? " · result" : "");
      const body = details
        ? text.replace(
            new RegExp(
              `^\\[${details.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: result)?\\] `,
            ),
            "",
          )
        : text;
      const innerWidth = Math.max(1, width - 2);
      const wrapped = wrapTextWithAnsi(body, innerWidth);
      const lines = [
        ...wrapTextWithAnsi(header, innerWidth),
        ...(options.expanded && details
          ? wrapTextWithAnsi(theme.fg("dim", `from ${details.from}\nto ${details.to}`), innerWidth)
          : []),
        "",
        ...(options.expanded ? wrapped : wrapped.slice(0, 3).map((line) => theme.fg("dim", line))),
        ...(!options.expanded && wrapped.length > 3
          ? [
              theme.fg(
                "muted",
                `… ${wrapped.length - 3} more lines · ${keyHint("app.tools.expand", "to expand")}`,
              ),
            ]
          : []),
      ];

      return [style(""), ...lines.map((line) => style(` ${line}`)), style("")];
    },
  });
}