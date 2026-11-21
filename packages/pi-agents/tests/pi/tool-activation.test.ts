import { describe, expect, test } from "bun:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agentExtension from "../../src/index.js";
import { tempDir } from "../agents/helpers.js";

describe("Tool activation", () => {
  test("tools and prompt guidance are opt-in and activation survives reload", async () => {
    const cwd = tempDir();
    const runtime = await createAgentSessionRuntime(
      async ({ cwd, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir: tempDir(),
          settingsManager: SettingsManager.inMemory(),
          resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [agentExtension],
          },
        });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            noTools: "builtin",
          })),
          services,
          diagnostics: services.diagnostics,
        };
      },
      { cwd, sessionManager: SessionManager.inMemory(cwd) },
    );
    try {
      const errors: unknown[] = [];
      await runtime.session.bindExtensions({
        mode: "json",
        onError: (error) => errors.push(error),
      });
      expect(errors).toEqual([]);
      expect(runtime.session.getActiveToolNames()).not.toContain("agent_wait");
      expect(runtime.session.getCallableToolNames()).not.toContain(
        "agent_spawn",
      );
      expect(runtime.session.systemPrompt).not.toContain("<agent_profiles>");
      await runtime.session.prompt("/agents enable");
      expect(runtime.session.getActiveToolNames()).toContain("agent_wait");
      const entries = () =>
        runtime.session.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "pi-agents-enabled",
          );
      expect(entries()).toHaveLength(1);
      await runtime.session.prompt("/agents enable");
      expect(entries()).toHaveLength(1);
      await runtime.session.reload();
      expect(runtime.session.getActiveToolNames()).toContain("agent_wait");
      expect(entries()).toHaveLength(1);
      await runtime.newSession();
      await runtime.session.bindExtensions({ mode: "json" });
      expect(runtime.session.getActiveToolNames()).not.toContain("agent_wait");
      expect(runtime.session.getCallableToolNames()).not.toContain(
        "agent_spawn",
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("--agents enables new and continued sessions without duplicate markers", async () => {
    for (const alreadyEnabled of [false, true]) {
      const cwd = tempDir();
      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendCustomEntry("existing-session", {});
      if (alreadyEnabled)
        sessionManager.appendCustomEntry("pi-agents-enabled", {});
      let flag = true;
      const runtime = await createAgentSessionRuntime(
        async ({ cwd, sessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir: tempDir(),
            settingsManager: SettingsManager.inMemory(),
            extensionFlagValues: flag ? new Map([["agents", true]]) : undefined,
            resourceLoaderOptions: {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              extensionFactories: [agentExtension],
            },
          });
          return {
            ...(await createAgentSessionFromServices({
              services,
              sessionManager,
              sessionStartEvent,
              noTools: "builtin",
            })),
            services,
            diagnostics: services.diagnostics,
          };
        },
        { cwd, sessionManager },
      );
      try {
        const errors: unknown[] = [];
        await runtime.session.bindExtensions({
          mode: "json",
          onError: (error) => errors.push(error),
        });
        const entries = () =>
          runtime.session.sessionManager
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "pi-agents-enabled",
            );
        expect(runtime.diagnostics).toEqual([]);
        expect(runtime.session.getActiveToolNames()).toContain("agent_wait");
        expect(runtime.session.getCallableToolNames()).toContain("agent_spawn");
        expect(entries()).toHaveLength(1);
        await runtime.session.reload();
        expect(runtime.session.getActiveToolNames()).toContain("agent_wait");
        expect(entries()).toHaveLength(1);
        await runtime.newSession();
        await runtime.session.bindExtensions({ mode: "json" });
        expect(runtime.session.getActiveToolNames()).toContain("agent_wait");
        expect(entries()).toHaveLength(1);
        flag = false;
        await runtime.newSession();
        await runtime.session.bindExtensions({ mode: "json" });
        expect(runtime.session.getActiveToolNames()).not.toContain(
          "agent_wait",
        );
        expect(entries()).toHaveLength(0);
        expect(errors).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    }
  });
});
