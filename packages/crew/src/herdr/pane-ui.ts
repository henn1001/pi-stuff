import { createConnection } from "node:net";
import { herdr, requireHerdr } from "./cli.ts";

/** Pane presentation and focus for user-initiated actions; not a Crew launch/prompt/close command. */
export async function renamePane(paneId: string, title: string): Promise<void> {
  await herdr(["pane", "rename", paneId, title], false);
}

/** The CLI exposes directional focus only; use the documented direct socket method. */
export async function focusPane(paneId: string): Promise<void> {
  requireHerdr();

  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) {
    throw new Error("Herdr socket path is unavailable for direct pane focus.");
  }

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let pending = "";
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(5_000, () => finish(new Error("Herdr pane focus timed out.")));
    socket.on("error", finish);

    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: "crew:focus", method: "pane.focus", params: { pane_id: paneId } })}\n`,
      ),
    );

    socket.on("data", (chunk) => {
      pending += chunk.toString();
      if (!pending.includes("\n")) {
        return;
      }

      try {
        const reply = JSON.parse(pending.slice(0, pending.indexOf("\n")));
        if (reply.error || !reply.result) {
          throw new Error(reply.error?.message ?? "Invalid Herdr focus reply.");
        }
        finish();
      } catch (error) {
        finish(error as Error);
      }
    });

    socket.on("end", () => finish(new Error("Herdr closed before focus acknowledgement.")));
  });
}