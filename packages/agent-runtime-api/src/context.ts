import type { FilesService } from "./modules/files/types.js";

export interface AgentRuntimeContext {
  files: FilesService;
}
