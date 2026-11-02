import { z } from 'zod'

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TURSO_DATABASE_URL: z.string().min(1).default('file:./local.db'),
  TURSO_AUTH_TOKEN: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  TRUSTED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  IMPORT_MAX_FILE_BYTES: z.coerce.number().int().min(1024).max(4 * 1024 * 1024).default(4 * 1024 * 1024),
}).refine((data) => {
  if (data.APP_ENV === 'production') {
    if (data.TURSO_DATABASE_URL.startsWith('file:')) {
      throw new Error('Production environment cannot use a local file database URL.')
    }
    if (!data.TURSO_AUTH_TOKEN) {
      throw new Error('Production environment requires TURSO_AUTH_TOKEN.')
    }
  }
  return true
}, { message: 'Production environment database configuration is invalid or missing.' })

export const env = environmentSchema.parse(process.env)
export const trustedOrigins = env.TRUSTED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
