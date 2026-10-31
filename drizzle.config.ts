import { defineConfig } from 'drizzle-kit'

const environment = process.env.APP_ENV ?? 'development'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: `./drizzle/${environment}`,
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? 'file:./local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  strict: true,
  verbose: true,
})
