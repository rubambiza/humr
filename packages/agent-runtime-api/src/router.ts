import { t } from "./trpc.js";
import { filesRouter } from "./modules/files/router.js";
import { messagesRouter } from "./modules/messages/router.js";

export const appRouter = t.router({
  files: filesRouter,
  messages: messagesRouter,
});

export type AppRouter = typeof appRouter;
