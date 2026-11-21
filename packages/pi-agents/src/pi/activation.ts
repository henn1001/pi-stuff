import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const ACTIVATION_ENTRY = "pi-agents-enabled";

/** Session opt-in, restored independently of commands and terminal UI. */
export interface Activation {
  isEnabled(): boolean;
  enable(ctx: ExtensionContext): Promise<void>;
  restore(ctx: ExtensionContext): Promise<void>;
}

/** One controller per extension instance; Pi recreates it on session replacement. */
export function createActivation(
  pi: Pick<ExtensionAPI, "appendEntry">,
  start: (ctx: ExtensionContext) => Promise<void>,
  registerTools: () => void,
): Activation {
  let enabled = false;
  let enabling: Promise<void> | undefined;
  const enable = (ctx: ExtensionContext, persist: boolean): Promise<void> => {
    if (enabled) return Promise.resolve();
    enabling ??= (async () => {
      await start(ctx);
      registerTools();
      if (persist) pi.appendEntry(ACTIVATION_ENTRY, {});
      enabled = true;
    })().finally(() => {
      enabling = undefined;
    });
    return enabling;
  };
  return {
    isEnabled: () => enabled,
    enable: (ctx) => enable(ctx, true),
    async restore(ctx) {
      if (
        ctx.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom" && entry.customType === ACTIVATION_ENTRY,
          )
      )
        await enable(ctx, false);
    },
  };
}
