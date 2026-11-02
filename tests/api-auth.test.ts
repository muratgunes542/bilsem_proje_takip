import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from '../server/api/router'
import * as schema from '../server/db/schema'

describe('API Auth and Security Enforcement', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `api-auth-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: 'admin-1', name: 'Admin User', email: 'admin@test.com', role: 'ADMIN', isActive: true },
      { id: 'teacher-1', name: 'Active Teacher', email: 'teacher1@test.com', role: 'TEACHER', isActive: true },
      { id: 'teacher-inactive', name: 'Inactive Teacher', email: 'inactive@test.com', role: 'TEACHER', isActive: false },
    ])
  })

  afterEach(async () => {
    await client.close()
  })

  it('returns 401 UNAUTHORIZED for requests without session or auth header', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/me',
      headers: {},
    }, db)

    expect(res.statusCode).toBe(401)
    expect(res.payload.success).toBe(false)
    expect(res.payload.error?.code).toBe('UNAUTHORIZED')
  })

  it('returns 403 FORBIDDEN when user is inactive', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/me',
      headers: { 'x-test-user-id': 'teacher-inactive' },
    }, db)

    expect(res.statusCode).toBe(403)
    expect(res.payload.success).toBe(false)
    expect(res.payload.error?.code).toBe('FORBIDDEN')
    expect(res.payload.error?.message).toContain('pasif')
  })

  it('returns current user profile without sensitive fields on GET /api/me', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/me',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.success).toBe(true)
    const user = res.payload.data as Record<string, unknown>
    expect(user.id).toBe('teacher-1')
    expect(user.role).toBe('TEACHER')
    expect(user.email).toBe('teacher1@test.com')
    expect(user.password).toBeUndefined()
  })

  it('does not expose credentials in admin user lists and prevents removing the last active administrator', async () => {
    const list = await handleApiRequest({ method: 'GET', url: '/api/admin/users', headers: { 'x-test-user-id': 'admin-1' } }, db)
    expect(list.statusCode).toBe(200)
    expect(JSON.stringify(list.payload.data)).not.toContain('password')
    const update = await handleApiRequest({ method: 'PATCH', url: '/api/admin/users/admin-1', headers: { 'x-test-user-id': 'admin-1' }, body: { role: 'TEACHER' } }, db)
    expect(update.statusCode).toBe(422)
    expect(update.payload.error?.message).toContain('en az bir etkin yönetici')
  })

  it('rejects client spoofing attempts where client sends fake userId or ADMIN role in body', async () => {
    // Teacher attempting to pass spoofed userId and role in request body
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/users',
      headers: { 'x-test-user-id': 'teacher-1' },
      body: { userId: 'admin-1', role: 'ADMIN' },
    }, db)

    // Server must check session identity, NOT body role -> 403 Forbidden
    expect(res.statusCode).toBe(403)
    expect(res.payload.success).toBe(false)
  })
})
