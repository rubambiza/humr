export const SessionType = {
  Regular: "regular",
  ChannelSlack: "channel_slack",
  ScheduleCron: "schedule_cron",
  ScheduleHeartbeat: "schedule_heartbeat",
} as const;

export type SessionType = (typeof SessionType)[keyof typeof SessionType];

export interface SessionView {
  sessionId: string;
  instanceId: string;
  type: SessionType;
  createdAt: string;
  scheduleId?: string | null;
  title?: string | null;
  updatedAt?: string | null;
}

export interface SessionsService {
  list(instanceId: string, includeChannel?: boolean): Promise<SessionView[]>;
  create(sessionId: string, instanceId: string, type?: SessionType, scheduleId?: string): Promise<void>;
  listByScheduleId(scheduleId: string): Promise<SessionView[]>;
  findByScheduleId(scheduleId: string): Promise<SessionView | null>;
  resetByScheduleId(scheduleId: string): Promise<void>;
}
