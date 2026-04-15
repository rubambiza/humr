import { pgTable, text, jsonb, uniqueIndex, primaryKey, timestamp, boolean } from "drizzle-orm/pg-core";

export const channels = pgTable("channels", {
  instanceId: text("instance_id").notNull(),
  owner: text("owner").notNull(),
  type: text("type").notNull(),
  config: jsonb("config").notNull(),
}, (table) => [
  uniqueIndex("channels_instance_type_idx").on(table.instanceId, table.type),
]);

export const identityLinks = pgTable("identity_links", {
  slackUserId: text("slack_user_id").primaryKey(),
  keycloakSub: text("keycloak_sub").notNull(),
  refreshToken: text("refresh_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const allowedUsers = pgTable("allowed_users", {
  instanceId: text("instance_id").notNull(),
  owner: text("owner").notNull(),
  keycloakSub: text("keycloak_sub").notNull(),
}, (table) => [
  primaryKey({ columns: [table.instanceId, table.keycloakSub] }),
]);

export const sessions = pgTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  type: text("type").notNull().default("regular"),
  scheduleId: text("schedule_id"),
  scheduleActive: boolean("schedule_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
