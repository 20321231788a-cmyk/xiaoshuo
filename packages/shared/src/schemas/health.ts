import { z } from "zod";

export const healthSchema = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    machineCode: z.string().optional(),
    deviceCode: z.string().optional()
  })
  .passthrough();

export type Health = z.infer<typeof healthSchema>;

