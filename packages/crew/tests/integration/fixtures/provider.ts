// Deterministic provider fixture for real Pi turns; it never calls a remote model.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
  pi.registerProvider("crew-validation", {
    api: "crew-validation-stream",
    apiKey: "fixture",
    baseUrl: "http://unused.invalid",
    models: [
      {
        id: "deterministic",
        name: "Crew integration fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model: any, context: any, options: any) {
      const root = process.env.CREW_RUNTIME_PLAN;
      const requests = process.env.CREW_RUNTIME_REQUESTS;
      if (!root || !requests) {
        throw new Error("Integration provider paths are required");
      }

      const agent = process.env.PI_CREW_AGENT;
      const definitionPlan = agent ? `${root}.${agent}` : "";
      const path =
        process.env.PI_SUBAGENT_ID === "true"
          ? definitionPlan && existsSync(definitionPlan)
            ? definitionPlan
            : `${root}.child`
          : root;
      const plan = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(plan) || plan.length === 0) {
        throw new Error(`Integration provider plan exhausted for ${agent ?? "lead"}`);
      }

      const next = plan.shift();
      writeFileSync(path, `${JSON.stringify(plan)}\n`);
      appendFileSync(requests, `${JSON.stringify({ agent: agent ?? "lead", context, next })}\n`);

      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      stream.push({ type: "start", partial: message });
      void (async () => {
        if (next.waitForFile) {
          while (!existsSync(next.waitForFile)) {
            if (options.signal?.aborted) {
              message.stopReason = "aborted";
              message.errorMessage = "Integration provider request was aborted";
              stream.push({ type: "error", reason: "aborted", error: message });
              stream.end();
              return;
            }
            await delay(20);
          }
        }

        if (next.error) {
          message.stopReason = "error";
          message.errorMessage = next.error;
          stream.push({ type: "error", reason: "error", error: message });
          stream.end();
          return;
        }

        if (next.tool) {
          message.stopReason = "toolUse";
          message.content.push({
            type: "toolCall",
            id: crypto.randomUUID(),
            name: next.tool,
            arguments: next.args,
          });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: message.content[0],
            partial: message,
          });
        } else {
          if (typeof next.text !== "string") {
            throw new Error("Provider plan steps require text or a tool call");
          }
          message.content.push({ type: "text", text: next.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: next.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: next.text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })().catch((error) => {
        message.stopReason = "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end();
      });
      return stream;
    },
  });
}