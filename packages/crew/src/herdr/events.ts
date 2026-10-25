import { createConnection, type Socket } from "node:net";

/** One subscription connection per runtime. Status subscriptions require pane_id.
 * Rebuild on watch changes/reconnect and reconcile missed events; never infer exit here.
 */
export function watchHerdrEvents(wake: () => void, initialPanes: string[]) {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) {
    throw new Error("Crew supervision requires HERDR_SOCKET_PATH.");
  }
  let stopped = false;
  let socket: Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let subscribed = "";
  let panes = [...new Set(initialPanes)].sort();
  const connect = () => {
    if (stopped) {
      return;
    }
    const ids = panes;
    subscribed = JSON.stringify(ids);
    const connection = createConnection(path);
    socket = connection;
    let pending = "";
    connection.on("connect", () => {
      if (stopped || socket !== connection || connection.destroyed) {
        return;
      }
      connection.write(
        `${JSON.stringify({ id: "crew:supervision", method: "events.subscribe", params: { subscriptions: [{ type: "pane.closed" }, ...ids.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id }))] } })}\n`,
      );
      wake();
    });
    connection.on("data", (chunk) => {
      if (stopped || socket !== connection || connection.destroyed) {
        return;
      }
      pending += chunk.toString();
      if (pending.length > 1024 * 1024) {
        connection.destroy();
        return;
      }
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.error) {
            connection.destroy();
            return;
          }
          wake();
        } catch {
          connection.destroy();
          return;
        }
      }
    });
    connection.on("error", () => connection.destroy());
    connection.on("close", () => {
      if (!stopped && socket === connection) {
        socket = undefined;
        retry = setTimeout(connect, 1000);
        retry.unref();
      }
    });
  };
  connect();
  return {
    refresh(currentPanes: string[]) {
      panes = [...new Set(currentPanes)].sort();
      if (JSON.stringify(panes) !== subscribed) {
        socket?.destroy();
      }
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      socket?.destroy();
    },
  };
}