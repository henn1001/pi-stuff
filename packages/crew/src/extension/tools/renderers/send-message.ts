import type { SendMessageToolDefinition } from "../send-message.ts";
import { renderToolResult, renderPromptCall } from "./shared.ts";

/** Render explicit neighbor input without implying delivery or a reply. */
export const sendMessageRenderers: Pick<SendMessageToolDefinition, "renderCall" | "renderResult"> =
  {
    renderCall(args, theme, context) {
      return renderPromptCall(args.message, "send_message", args.target, theme, context);
    },
    renderResult: renderToolResult("Durably accepted · not delivery or settlement"),
  };