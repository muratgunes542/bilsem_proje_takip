import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { afterEach, describe, expect, it } from 'vitest'
import * as schema from '../server/db/schema'

const clients: ReturnType<typeof createClient>[] = []

afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())) })

describe('Better Auth password length policy', () => {
  it('accepts an eight-character password on the server', async () => {
    const client = createClient({ url: `file:${join(tmpdir(), `password-policy-${randomUUID()}.db`)}` })
    clients.push(client)
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    const auth = betterAuth({ baseURL: 'http://localhost:3000', secret: 'test-secret-that-is-long-enough-for-better-auth', database: drizzleAdapter(db, { provider: 'sqlite', schema, usePlural: true }), emailAndPassword: { enabled: true, minPasswordLength: 8 } })
    const result = await auth.api.signUpEmail({ body: { name: 'TEST Teacher', email: 'test-password@test.invalid', password: 'Abcd1234' } })
    expect(result.user.email).toBe('test-password@test.invalid')
  })

  it('rejects a seven-character password on the server', async () => {
    const client = createClient({ url: `file:${join(tmpdir(), `password-policy-${randomUUID()}.db`)}` })
    clients.push(client)
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    const auth = betterAuth({ baseURL: 'http://localhost:3000', secret: 'test-secret-that-is-long-enough-for-better-auth', database: drizzleAdapter(db, { provider: 'sqlite', schema, usePlural: true }), emailAndPassword: { enabled: true, minPasswordLength: 8 } })
    await expect(auth.api.signUpEmail({ body: { name: 'TEST Teacher', email: 'test-short@test.invalid', password: 'Abcd123' } })).rejects.toThrow()
    expect(await db.select().from(schema.users)).toHaveLength(0)
  })
})
