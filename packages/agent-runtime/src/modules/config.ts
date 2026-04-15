import { z } from "zod/v4";

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  HUMR_DEV: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  WORKSPACE_DIR: z.string().default("/workspace"),
  TRIGGERS_DIR: z.string().default("/workspace/.triggers"),
  API_SERVER_URL: z.string().default(""),
});

export const config = schema.parse(process.env);
