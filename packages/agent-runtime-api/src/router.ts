import { t } from "./trpc.js";
import { filesRouter } from "./modules/files/router.js";

export const appRouter = t.router({
  files: filesRouter,
});

export type AppRouter = typeof appRouter;
