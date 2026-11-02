import { migrate } from 'drizzle-orm/libsql/migrator'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { db } from '../server/db/client'
import { env } from '../server/env'

export type MigrationValidationOptions = {
  appEnv: string
  databaseUrl: string
  authToken?: string
  confirmationInput?: string
  expectedDatabaseName?: string
}

export function validateMigrationTarget(options: MigrationValidationOptions): void {
  if (options.appEnv === 'production') {
    if (!options.databaseUrl || !options.databaseUrl.startsWith('libsql://')) {
      throw new Error('Production migration aborted: TURSO_DATABASE_URL must be a remote libsql:// database.')
    }
    if (!options.authToken) {
      throw new Error('Production migration aborted: TURSO_AUTH_TOKEN is required.')
    }
    if (options.confirmationInput !== 'MIGRATE_PROD') {
      throw new Error('Migration canceled: Invalid or missing confirmation input.')
    }
    if (options.expectedDatabaseName && !options.databaseUrl.includes(options.expectedDatabaseName)) {
      throw new Error(`Migration canceled: Target database URL does not match expected database name '${options.expectedDatabaseName}'.`)
    }
  }
}

async function run() {
  if (env.APP_ENV === 'production') {
    console.log(`\nUYARI: Üretim veritabanına migration uygulanıyor!`)
    console.log(`Hedef Veritabanı URL: ${env.TURSO_DATABASE_URL}`)

    let answer: string
    if (process.env.MIGRATE_CONFIRM === 'yes') {
      answer = 'MIGRATE_PROD'
    } else {
      const readline = createInterface({ input: stdin, output: stdout })
      try {
        answer = (await readline.question("Üretim veritabanına migration uygulamak için 'MIGRATE_PROD' yazın: ")).trim()
      } finally {
        readline.close()
      }
    }

    validateMigrationTarget({
      appEnv: env.APP_ENV,
      databaseUrl: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
      confirmationInput: answer,
    })
  }

  await migrate(db, { migrationsFolder: `drizzle/${env.APP_ENV}` })
  console.log(`Migration completed for ${env.APP_ENV}.`)
}

if (process.env.MIGRATE_RUN === 'true' || process.env.NODE_ENV !== 'test') {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
