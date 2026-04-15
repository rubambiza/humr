export type Role = "user" | "assistant";

export interface ToolContent {
  type: "content" | "diff" | "terminal";
  text?: string;
}

export interface ToolChip {
  kind: "tool";
  toolCallId?: string;
  title: string;
  status: string;
  content?: ToolContent[];
}

export interface TextPart {
  kind: "text";
  text: string;
}

export type MessagePart = TextPart | ToolChip;

export interface Message {
  id: string;
  role: Role;
  parts: MessagePart[];
  streaming: boolean;
}

export interface LogEntry {
  id: string;
  ts: string;
  type: string;
  payload: object;
}

export { SessionType } from "api-server-api";
export type { SessionView } from "api-server-api";

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

export interface TemplateView {
  id: string;
  name: string;
  image: string;
  description?: string;
}

export interface AgentView {
  id: string;
  name: string;
  templateId: string | null;
  image: string;
  description?: string;
}

export type InstanceState = "starting" | "running" | "hibernating" | "hibernated" | "error";

export interface InstanceView {
  id: string;
  name: string;
  agentId: string;
  description?: string;
  state: InstanceState;
  error?: string;
  channels: { type: string; slackChannelId: string }[];
  allowedUsers: string[];
}

export interface Schedule {
  id: string;
  name: string;
  instanceId: string;
  type: "heartbeat" | "cron";
  cron: string;
  task: string | null;
  enabled: boolean;
  sessionMode?: "continuous" | "fresh";
  status: { lastRun?: string; nextRun?: string; lastResult?: string } | null;
}

export type SecretType = "anthropic" | "generic";
export type SecretMode = "all" | "selective";
export type AnthropicAuthMode = "api-key" | "oauth";

/** Prefix used for MCP OAuth secrets stored in OneCLI. */
export const MCP_SECRET_PREFIX = "__humr_mcp:";

export function isMcpSecret(s: { name: string; type: SecretType }): boolean {
  return s.type !== "anthropic" && s.name.startsWith(MCP_SECRET_PREFIX);
}

export function mcpHostnameFromSecretName(name: string): string {
  return name.startsWith(MCP_SECRET_PREFIX) ? name.slice(MCP_SECRET_PREFIX.length) : name;
}

export interface SecretView {
  id: string;
  name: string;
  type: SecretType;
  hostPattern: string;
  createdAt: string;
  authMode?: AnthropicAuthMode;
}

export interface McpConnection {
  hostname: string;
  connectedAt: string;
  expired: boolean;
}
