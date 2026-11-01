import { z } from 'zod'

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TURSO_DATABASE_URL: z.string().min(1).default('file:./local.db'),
  TURSO_AUTH_TOKEN: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  TRUSTED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
})

export const env = environmentSchema.parse(process.env)
export const trustedOrigins = env.TRUSTED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
