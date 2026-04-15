import type { FilesService } from "./modules/files/types.js";
import type { MessagesService } from "./modules/messages/types.js";

export interface AgentRuntimeContext {
  files: FilesService;
  messages: MessagesService;
}
