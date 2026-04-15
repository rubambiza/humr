import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { t } from "../../trpc.js";
import type { Schedule } from "./types.js";

function toView(sched: Schedule) {
  return {
    id: sched.id,
    name: sched.name,
    instanceId: sched.instanceId,
    type: sched.spec.type,
    cron: sched.spec.cron,
    task: sched.spec.task ?? null,
    enabled: sched.spec.enabled,
    sessionMode: sched.spec.sessionMode,
    status: sched.status ?? null,
  };
}

export const schedulesRouter = t.router({
  list: t.procedure
    .input(z.object({ instanceId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const schedules = await ctx.schedules.list(input.instanceId);
      return schedules.map(toView);
    }),

  get: t.procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const sched = await ctx.schedules.get(input.id);
      if (!sched) throw new TRPCError({ code: "NOT_FOUND" });
      return toView(sched);
    }),

  createCron: t.procedure
    .input(z.object({
      name: z.string().min(1),
      instanceId: z.string().min(1),
      cron: z.string().min(1),
      task: z.string().min(1),
      sessionMode: z.enum(["continuous", "fresh"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const sched = await ctx.schedules.createCron(input);
      return toView(sched);
    }),

  createHeartbeat: t.procedure
    .input(z.object({
      name: z.string().min(1),
      instanceId: z.string().min(1),
      intervalMinutes: z.number().int().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const sched = await ctx.schedules.createHeartbeat(input);
      return toView(sched);
    }),

  delete: t.procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => ctx.schedules.delete(input.id)),

  toggle: t.procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const sched = await ctx.schedules.toggle(input.id);
      if (!sched) throw new TRPCError({ code: "NOT_FOUND" });
      return toView(sched);
    }),

  config: t.procedure.query(({ ctx }) => ctx.schedules.config()),
});
