import { migrate } from 'drizzle-orm/libsql/migrator'
import { client, db } from '../server/db/client'
import { env } from '../server/env'

try {
  await migrate(db, { migrationsFolder: `drizzle/${env.APP_ENV}` })
  console.log(`Migration completed for ${env.APP_ENV}.`)
} finally {
  client.close()
}
