/**
 * One /agents command namespace and its activation/terminal guards.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FocusController } from "../ui/focus.js";
import { errorText } from "../ui/focus.js";
import { STATUS_STYLES, statusOf } from "../ui/format.js";
import type { AgentWorkspace } from "../ui/workspace.js";
import type { Activation } from "./activation.js";
import { notify } from "./notify.js";
import type { SessionHost } from "./session.js";

export interface CommandDeps {
  activation: Activation;
  host: SessionHost;
  focus: FocusController;
  workspace: AgentWorkspace;
}

/** Whether the views can open: they need Pi's terminal UI, which RPC
 * clients don't render. Says so where it can. */
function inTerminal(ctx: ExtensionContext, command: string): boolean {
  if (ctx.mode === "tui") return true;
  if (ctx.hasUI) ctx.ui.notify(`${command} needs Pi's terminal UI.`, "warning");
  return false;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  const openOverview = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      notify(
        ctx,
        "The agents overview needs Pi's terminal UI. Use /agents enable to activate without it.",
        "warning",
      );
      return;
    }
    if (!deps.activation.isEnabled()) {
      const confirmed = await ctx.ui.confirm(
        "Enable pi-agents for this session?",
        "This adds agent tools and instructions to the model context. It stays enabled until the session ends.",
      );
      if (!confirmed) return;
      await deps.activation.enable(ctx);
      notify(ctx, "pi-agents enabled for this session.", "info");
      // Activation is its own interaction; the next invocation opens Agents.
      return;
    }
    deps.focus.focusPanel(ctx);
  };
  pi.registerShortcut("ctrl+q", {
    description: "Open the agents overview",
    handler: openOverview,
  });

  pi.registerCommand("agents", {
    description: "Agents overview; enable, attach <name>, or messages",
    getArgumentCompletions: (prefix) => {
      if (!prefix.startsWith("attach ")) {
        const matches = ["enable", "attach", "messages"]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ value: name, label: name }));
        return matches.length ? matches : null;
      }
      const namePrefix = prefix.slice("attach ".length);
      const service = deps.host.current();
      const names = new Set(
        (service?.list({ includeClosed: true }) ?? []).map(
          (agent) => agent.name,
        ),
      );
      const matches = [...names]
        .filter((name) => name.startsWith(namePrefix))
        .flatMap((name) => service?.get(name) ?? []);
      return matches.length === 0
        ? null
        : matches.map((agent) => ({
            value: `attach ${agent.name}`,
            label: agent.name,
            description: `${STATUS_STYLES[statusOf(agent)].icon} ${agent.job.replace(/\s+/g, " ").slice(0, 60)}`,
          }));
    },
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "enable") {
        if (deps.activation.isEnabled()) {
          notify(ctx, "pi-agents is already enabled.", "info");
          return;
        }
        await deps.activation.enable(ctx);
        notify(ctx, "pi-agents enabled for this session.", "info");
        return;
      }
      if (!command) {
        await openOverview(ctx).catch((error) =>
          notify(ctx, errorText(error), "error"),
        );
        return;
      }
      if (command !== "messages" && !command.startsWith("attach ")) {
        notify(
          ctx,
          "Usage: /agents [enable | attach <name> | messages]",
          "warning",
        );
        return;
      }
      if (!deps.activation.isEnabled()) {
        notify(ctx, "Enable pi-agents first with /agents enable.", "warning");
        return;
      }
      if (!inTerminal(ctx, "/agents")) return;
      if (command === "messages") {
        await deps.workspace
          .openMessages(ctx)
          .catch((error) => notify(ctx, errorText(error), "error"));
        return;
      }
      const name = command.slice("attach ".length).trim();
      const agent = deps.host.current()?.get(name);
      if (!agent) {
        ctx.ui.notify(`No agent named ${name}.`, "warning");
        return;
      }
      deps.focus.attach(ctx, agent.id);
    },
  });
}
