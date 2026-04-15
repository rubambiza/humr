import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { appRouter } from "agent-runtime-api/router";
import type { AgentRuntimeContext } from "agent-runtime-api";
import { createFilesService } from "./modules/files.js";
import { config } from "./modules/config.js";
import { spawnAcpSession } from "./acp-bridge.js";
import { startTriggerWatcher, type TriggerWatcher } from "./trigger-watcher.js";

let triggerWatcher: TriggerWatcher | undefined;

const __dir = dirname(fileURLToPath(import.meta.url));
const agentScript = join(__dir, config.HUMR_DEV ? "agent.ts" : "agent.js");
const workingDir = config.HUMR_DEV
  ? join(__dir, "../working-dir")
  : config.WORKSPACE_DIR;

const createContext = (): AgentRuntimeContext => ({
  files: createFilesService(workingDir),
  messages: {
    async getSessionMessages(sessionId, opts) {
      // TODO: Wire to ACP SDK's getSessionMessages when available.
      // The SDK reads from the session's JSONL transcript on disk.
      // For now, return empty array — the tRPC route is functional,
      // the SDK integration is a follow-up.
      process.stderr.write(`[messages] getSessionMessages(${sessionId}, ${JSON.stringify(opts)})\n`);
      return [];
    },
  },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext,
});

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS).end();
    return;
  }

  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  if (req.url === "/api/status") {
    const status = {
      activeSessions: wss.clients.size,
      activeTriggers: triggerWatcher?.activeCount() ?? 0,
    };
    res.writeHead(200, { "Content-Type": "application/json", ...CORS }).end(JSON.stringify(status));
    return;
  }

  if (req.url?.startsWith("/api/trpc")) {
    req.url = req.url.replace("/api/trpc", "");
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    trpcHandler(req, res);
    return;
  }

  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/api/acp" });

wss.on("connection", (ws) => {
  const session = spawnAcpSession({ agentScript, workingDir, isDev: config.HUMR_DEV });

  session.onMessage((line) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        const msg = JSON.parse(line);
        const hint =
          "Authentication Error: Ensure the API/OAuth credential secret is correct and linked to this agent in the OneCLI dashboard (Agents > select agent > Secrets).\n\nError: ";

        // JSON-RPC error response (e.g. internal error wrapping the API failure)
        if (msg.error?.message?.includes("authentication_error")) {
          msg.error.message = hint + msg.error.message;
          ws.send(JSON.stringify(msg));
          return;
        }

        // Session update notification (agent_message_chunk with error text)
        const text = msg.params?.update?.content?.text;
        if (typeof text === "string" && text.includes("authentication_error")) {
          msg.params.update.content.text = hint + msg.params.update.content.text;
          ws.send(JSON.stringify(msg));
          return;
        }
      } catch {
        // not JSON — relay as-is
      }
      ws.send(line);
    }
  });

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.params?.cwd !== undefined) {
        msg.params.cwd = workingDir;
      }
      session.send(msg);
    } catch {
      process.stderr.write(`[acp] Dropping non-JSON WebSocket message: ${data.toString()}\n`);
    }
  });

  ws.on("close", () => session.kill());
  session.exited.then(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
});

server.listen(config.PORT, () => {
  process.stderr.write(`Humr on http://localhost:${config.PORT}\n`);

  triggerWatcher = startTriggerWatcher({
    triggersDir: config.TRIGGERS_DIR,
    apiServerUrl: config.API_SERVER_URL,
    instanceId: process.env.ADK_INSTANCE_ID ?? process.env.HOSTNAME ?? "unknown",
  });
});
