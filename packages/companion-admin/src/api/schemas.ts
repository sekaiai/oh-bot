import { z } from 'zod';

export const successSchema = z.object({ ok: z.boolean() });
export const loginSchema = z.object({ token: z.string().min(1), expiresAt: z.string().optional() });
export const overviewSchema = z.object({ health: z.string(), configured: z.record(z.string(), z.boolean()), counts: z.record(z.string(), z.number()), updatedAt: z.string().optional() });
export const listSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())), configured: z.boolean().optional(), message: z.string().optional() });
export type Overview = z.infer<typeof overviewSchema>;
export type AdminList = z.infer<typeof listSchema>;
