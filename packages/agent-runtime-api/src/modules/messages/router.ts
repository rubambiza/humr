import { z } from "zod";
import { t } from "../../trpc.js";

export const messagesRouter = t.router({
  list: t.procedure
    .input(z.object({
      sessionId: z.string().min(1),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }))
    .query(({ ctx, input }) =>
      ctx.messages.getSessionMessages(input.sessionId, {
        limit: input.limit,
        offset: input.offset,
      }),
    ),
});
