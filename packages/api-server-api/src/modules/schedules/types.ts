export interface ScheduleSpec {
  version: string;
  type: "heartbeat" | "cron";
  cron: string;
  task?: string;
  enabled: boolean;
  sessionMode?: "continuous" | "fresh";
}

export interface ScheduleStatus {
  lastRun?: string;
  nextRun?: string;
  lastResult?: string;
}

export interface Schedule {
  id: string;
  name: string;
  instanceId: string;
  spec: ScheduleSpec;
  status?: ScheduleStatus;
}

export interface CreateCronScheduleInput {
  name: string;
  instanceId: string;
  cron: string;
  task: string;
  sessionMode?: "continuous" | "fresh";
}

export interface CreateHeartbeatScheduleInput {
  name: string;
  instanceId: string;
  intervalMinutes: number;
}

export interface ScheduleConfig {
  defaultHeartbeatIntervalMinutes: number;
}

export interface SchedulesService {
  list: (instanceId: string) => Promise<Schedule[]>;
  get: (id: string) => Promise<Schedule | null>;
  createCron: (input: CreateCronScheduleInput) => Promise<Schedule>;
  createHeartbeat: (input: CreateHeartbeatScheduleInput) => Promise<Schedule>;
  delete: (id: string) => Promise<void>;
  toggle: (id: string) => Promise<Schedule | null>;
  config: () => ScheduleConfig;
}
