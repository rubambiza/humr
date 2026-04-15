import type {
  SchedulesService,
  CreateCronScheduleInput,
  CreateHeartbeatScheduleInput,
} from "api-server-api";
import { SPEC_VERSION } from "api-server-api";
import type { SchedulesRepository } from "../infrastructure/SchedulesRepository.js";
import { validateCron, minutesToCron } from "../domain/cron.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from "../domain/defaults.js";

export function createSchedulesService(deps: {
  repo: SchedulesRepository;
  owner: string;
}): SchedulesService {
  return {
    list: (instanceId) => deps.repo.list(instanceId, deps.owner),
    get: (id) => deps.repo.get(id, deps.owner),

    async createCron(input: CreateCronScheduleInput) {
      validateCron(input.cron);
      const agentRef = await deps.repo.readAgentRef(input.instanceId, deps.owner);
      if (!agentRef) throw new Error(`Instance "${input.instanceId}" not found`);

      const spec: Record<string, unknown> = {
        name: input.name,
        version: SPEC_VERSION,
        type: "cron" as const,
        cron: input.cron,
        task: input.task,
        enabled: true,
      };
      if (input.sessionMode) spec.sessionMode = input.sessionMode;
      return deps.repo.create(input.instanceId, agentRef, spec, deps.owner);
    },

    async createHeartbeat(input: CreateHeartbeatScheduleInput) {
      const agentRef = await deps.repo.readAgentRef(input.instanceId, deps.owner);
      if (!agentRef) throw new Error(`Instance "${input.instanceId}" not found`);

      const spec = {
        name: input.name,
        version: SPEC_VERSION,
        type: "heartbeat" as const,
        cron: minutesToCron(input.intervalMinutes),
        task: "",
        enabled: true,
      };
      return deps.repo.create(input.instanceId, agentRef, spec, deps.owner);
    },

    delete: (id) => deps.repo.delete(id, deps.owner),
    toggle: (id) => deps.repo.toggle(id, deps.owner),

    config() {
      return { defaultHeartbeatIntervalMinutes: DEFAULT_HEARTBEAT_INTERVAL_MINUTES };
    },
  };
}
