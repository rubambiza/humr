import type * as k8s from "@kubernetes/client-node";
import type { Db } from "db";
import type { TemplatesService, AgentsService, InstancesService, SchedulesService, SessionsApiService } from "api-server-api";
import { createK8sClient } from "./infrastructure/k8s.js";
import { createTemplatesRepository } from "./infrastructure/TemplatesRepository.js";
import { createAgentsRepository } from "./infrastructure/AgentsRepository.js";
import { createInstancesRepository } from "./infrastructure/InstancesRepository.js";
import { createSchedulesRepository } from "./infrastructure/SchedulesRepository.js";
import {
  listChannelsByOwner, listChannelsByInstance,
  upsertChannel, deleteChannelByType,
  deleteChannelsByInstanceIds,
} from "./infrastructure/channels-repository.js";
import {
  listAllowedUsersByOwner, listAllowedUsersByInstance,
  setAllowedUsers, deleteAllowedUsersByInstanceIds,
} from "./infrastructure/allowed-users-repository.js";
import { listSessionsByInstance, listSessionsByScheduleId, findActiveByScheduleId, deactivateByScheduleId, upsertSession } from "./infrastructure/sessions-repository.js";
import { createTemplatesService } from "./services/TemplatesService.js";
import { createAgentsService } from "./services/AgentsService.js";
import { createInstancesService } from "./services/InstancesService.js";
import { createSchedulesService } from "./services/SchedulesService.js";
import { createSessionsService } from "./services/SessionsService.js";

export function composeAgentsModule(api: k8s.CoreV1Api, namespace: string, owner: string, db: Db): {
  templates: TemplatesService;
  agents: AgentsService;
  instances: InstancesService;
  schedules: SchedulesService;
  sessions: SessionsApiService;
} {
  const k8s = createK8sClient(api, namespace);
  const templatesRepo = createTemplatesRepository(k8s);
  const agentsRepo = createAgentsRepository(k8s);
  const instancesRepo = createInstancesRepository(k8s);
  const schedulesRepo = createSchedulesRepository(k8s);

  const agents = createAgentsService({
    repo: agentsRepo,
    owner,
    readTemplateSpec: (id) => templatesRepo.readSpec(id),
  });

  return {
    templates: createTemplatesService({ repo: templatesRepo }),
    agents,
    instances: createInstancesService({
      repo: instancesRepo,
      owner,
      getAgent: (id) => agents.get(id),
      listChannelsByOwner: listChannelsByOwner(db, owner),
      listChannelsByInstance: listChannelsByInstance(db, owner),
      upsertChannel: upsertChannel(db, owner),
      deleteChannelByType: deleteChannelByType(db, owner),
      deleteChannelsByInstanceIds: deleteChannelsByInstanceIds(db),
      listAllowedUsersByOwner: listAllowedUsersByOwner(db, owner),
      listAllowedUsersByInstance: listAllowedUsersByInstance(db, owner),
      setAllowedUsers: setAllowedUsers(db, owner),
      deleteAllowedUsersByInstanceIds: deleteAllowedUsersByInstanceIds(db),
    }),
    schedules: createSchedulesService({ repo: schedulesRepo, owner }),
    sessions: createSessionsService({
      listByInstance: listSessionsByInstance(db),
      listByScheduleId: listSessionsByScheduleId(db),
      findActiveByScheduleId: findActiveByScheduleId(db),
      upsert: upsertSession(db),
      deactivateByScheduleId: deactivateByScheduleId(db),
      namespace,
    }),
  };
}

export function composeSystemInstances(api: k8s.CoreV1Api, namespace: string, db: Db): InstancesService {
  const k8s = createK8sClient(api, namespace);
  const templatesRepo = createTemplatesRepository(k8s);
  const agentsRepo = createAgentsRepository(k8s);
  const instancesRepo = createInstancesRepository(k8s);

  const agents = createAgentsService({
    repo: agentsRepo,
    owner: "",
    readTemplateSpec: (id) => templatesRepo.readSpec(id),
  });

  return createInstancesService({
    repo: instancesRepo,
    owner: undefined,
    getAgent: (id) => agents.get(id),
    listChannelsByOwner: listChannelsByOwner(db, ""),
    listChannelsByInstance: listChannelsByInstance(db, ""),
    upsertChannel: upsertChannel(db, ""),
    deleteChannelByType: deleteChannelByType(db, ""),
    deleteChannelsByInstanceIds: deleteChannelsByInstanceIds(db),
    listAllowedUsersByOwner: listAllowedUsersByOwner(db, ""),
    listAllowedUsersByInstance: listAllowedUsersByInstance(db, ""),
    setAllowedUsers: setAllowedUsers(db, ""),
    deleteAllowedUsersByInstanceIds: deleteAllowedUsersByInstanceIds(db),
  });
}
