import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "api-server-api/router";
import type { ApiContext, UserIdentity } from "api-server-api";
import { createDb, runMigrations } from "db";
import {
  createApi, createK8sClient, podBaseUrl,
} from "./modules/agents/infrastructure/k8s.js";
import { createInstancesRepository } from "./modules/agents/infrastructure/InstancesRepository.js";
import { composeAgentsModule, composeSystemInstances, startK8sCleanupSaga, startChannelCleanupSaga } from "./modules/agents/index.js";
import { createAcpClient } from "./acp-client.js";
import { deleteChannelsByInstance } from "./modules/agents/infrastructure/channels-repository.js";
import { upsertSession } from "./modules/agents/infrastructure/sessions-repository.js";
import { createSlackWorker, type SlackOAuthPending } from "./modules/channels/infrastructure/slack.js";
import { createSlackOAuthRoutes } from "./modules/channels/infrastructure/slack-oauth.js";
import { createChannelManager } from "./modules/channels/services/ChannelManager.js";
import { createIdentityLinkService } from "./modules/channels/services/IdentityLinkService.js";
import {
  findIdentityBySlackUser, upsertIdentityLink, deleteIdentityLink,
} from "./modules/channels/infrastructure/identity-links-repository.js";
import { createAcpRelay } from "./acp-relay.js";
import { createOAuthRoutes } from "./oauth.js";
import { loadConfig } from "./config.js";
import { createAuth, ForbiddenError } from "./auth.js";
import { createOnecliClient } from "./onecli.js";
import { createOnecliSecretsPort } from "./modules/secrets/infrastructure/OnecliSecretsPort.js";
import { createSecretsService } from "./modules/secrets/services/SecretsService.js";

const config = loadConfig();

const auth = createAuth({
  issuerUrl: `${config.keycloakExternalUrl}/realms/${config.keycloakRealm}`,
  jwksUrl: `${config.keycloakUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/certs`,
  audience: config.keycloakApiAudience,
  requiredRole: config.keycloakRequiredRole,
});

const onecli = createOnecliClient({
  keycloakTokenUrl: `${config.keycloakUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/token`,
  clientId: config.keycloakApiClientId,
  clientSecret: config.keycloakApiClientSecret,
  onecliAudience: config.onecliAudience,
  onecliBaseUrl: config.onecliBaseUrl,
});

const { api } = createApi(config.namespace);
const k8sClient = createK8sClient(api, config.namespace);
const instancesRepo = createInstancesRepository(k8sClient);
await runMigrations(config.databaseUrl, config.migrationsPath);
const { db, sql } = createDb(config.databaseUrl);

// Start sagas — react to domain events for side effects
const k8sCleanupSub = startK8sCleanupSaga(k8sClient);
const channelCleanupSub = startChannelCleanupSaga(deleteChannelsByInstance(db));

const systemInstances = composeSystemInstances(api, config.namespace, db);

const persistSession = upsertSession(db);

const identityLinkService = createIdentityLinkService({
  findBySlackUser: findIdentityBySlackUser(db),
  upsert: upsertIdentityLink(db),
  delete: deleteIdentityLink(db),
});

const pendingSlackOAuthFlows = new Map<string, SlackOAuthPending>();

const slackOauthCallbackUrl = config.slackOauthCallbackUrl
  ?? `${config.uiBaseUrl}/api/slack/oauth/callback`;

const channelManager = createChannelManager({
  slackWorker: config.slackBotToken && config.slackAppToken
    ? createSlackWorker(
        config.namespace,
        config.slackBotToken,
        config.slackAppToken,
        () => systemInstances,
        persistSession,
        identityLinkService,
        {
          keycloakExternalUrl: config.keycloakExternalUrl,
          keycloakRealm: config.keycloakRealm,
          keycloakClientId: config.keycloakClientId,
          callbackUrl: slackOauthCallbackUrl,
        },
        pendingSlackOAuthFlows,
      )
    : undefined,
});

const app = new Hono<{ Variables: { user: UserIdentity } }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/api/auth/config", (c) =>
  c.json({
    issuer: `${config.keycloakExternalUrl}/realms/${config.keycloakRealm}`,
    clientId: config.keycloakClientId,
    onecliUrl: config.onecliExternalUrl,
  }),
);

// --- Internal endpoints (no JWT auth — secured by K8s NetworkPolicy) ---
// Called by agent-runtime trigger-watcher to execute scheduled sessions.
// Session lookup, creation, persistence, and ACP relay all happen here.
app.post("/internal/trigger", async (c) => {
  const body = await c.req.json<{
    instanceId: string;
    schedule: string;
    task: string;
    type?: "heartbeat" | "cron";
    sessionMode?: "continuous" | "fresh";
    mcpServers?: unknown[];
  }>();
  if (!body.instanceId || !body.schedule || !body.task) {
    return c.json({ error: "instanceId, schedule, task required" }, 400);
  }

  const mode = body.sessionMode ?? (body.type === "heartbeat" ? "continuous" : "fresh");
  const sessionType = body.type === "heartbeat" ? "schedule_heartbeat" : "schedule_cron";
  const { sessions } = composeAgentsModule(api, config.namespace, "_system", db);

  // For continuous mode, look up existing session
  let resumeSessionId: string | undefined;
  if (mode === "continuous") {
    const found = await sessions.findByScheduleId(body.schedule);
    resumeSessionId = found?.sessionId;
  }

  const acp = createAcpClient({
    namespace: config.namespace,
    instanceName: body.instanceId,
    onSessionCreated: (sid: string) => sessions.create(sid, body.instanceId, sessionType as any, body.schedule),
  });

  const result = await acp.triggerSession({
    prompt: body.task,
    resumeSessionId,
    mcpServers: body.mcpServers,
  });

  return c.json(result);
});

app.use("/api/*", auth.middleware);

app.route("/", createOAuthRoutes(config.uiBaseUrl, onecli));

if (config.slackBotToken && config.slackAppToken) {
  app.route("/", createSlackOAuthRoutes({
    pendingFlows: pendingSlackOAuthFlows,
    identityLinks: identityLinkService,
    keycloakUrl: config.keycloakUrl,
    keycloakRealm: config.keycloakRealm,
    keycloakClientId: config.keycloakClientId,
    callbackUrl: slackOauthCallbackUrl,
  }));
}

async function verifyOwner(instanceId: string, owner: string): Promise<boolean> {
  return instancesRepo.isOwnedBy(instanceId, owner);
}

app.all("/api/instances/:id/trpc/*", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id")!;
  if (!await verifyOwner(instanceId, user.sub)) {
    return c.json({ error: "not found" }, 404);
  }

  const rest = c.req.path.replace(`/api/instances/${instanceId}/trpc`, "");
  const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";
  const upstreamUrl = `http://${podBaseUrl(instanceId, config.namespace)}/api/trpc${rest}${qs}`;
  try {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      // @ts-expect-error -- node fetch supports duplex
      duplex: "half",
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } catch {
    return c.json({ error: "instance unreachable" }, 502);
  }
});

app.all("/api/trpc/*", (c) => {
  const user = c.get("user");
  const userJwt = c.req.header("authorization")!.slice(7);

  const { templates, agents, instances, schedules, sessions } = composeAgentsModule(api, config.namespace, user.sub, db);
  const secrets = createSecretsService({
    port: createOnecliSecretsPort(onecli, userJwt, user.sub),
  });

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (): ApiContext => ({
      templates,
      agents,
      instances,
      schedules,
      sessions,
      secrets,
      channels: { available: channelManager.availableChannels() },
      user,
    }),
  });
});

const server = serve({ fetch: app.fetch, port: config.port }, () => {
  process.stderr.write(`api-server listening on http://localhost:${config.port}\n`);
});

const acpRelay = createAcpRelay(config.namespace, instancesRepo);

systemInstances.list().then((all) => {
  channelManager.bootstrap(all);
}).catch(() => {});

async function shutdown() {
  process.stderr.write("shutting down...\n");
  k8sCleanupSub.unsubscribe();
  channelCleanupSub.unsubscribe();
  await channelManager.stopAll();
  await sql.end();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/api\/instances\/([^/]+)\/acp$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  let user: UserIdentity;
  try {
    user = await auth.verify(token);
  } catch (err) {
    const status = err instanceof ForbiddenError ? "403 Forbidden" : "401 Unauthorized";
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
    return;
  }

  const instanceId = decodeURIComponent(match[1]);
  if (!await verifyOwner(instanceId, user.sub)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  acpRelay.handleUpgrade(req, socket, head, instanceId);
});

export { createK8sClient, podBaseUrl, createApi };
export type { K8sClient } from "./modules/agents/infrastructure/k8s.js";
