import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from '../server/api/router'
import * as schema from '../server/db/schema'

describe('API Admin User Management', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `api-users-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: 'admin-1', name: 'System Admin', email: 'admin@test.com', role: 'ADMIN', isActive: true },
      { id: 'teacher-1', name: 'Ahmet Teacher', email: 'ahmet@test.com', role: 'TEACHER', isActive: true },
      { id: 'teacher-2', name: 'Mehmet Teacher', email: 'mehmet@test.com', role: 'TEACHER', isActive: true },
    ])
  })

  afterEach(async () => {
    await client.close()
  })

  it('allows Admin to list users with pagination and search', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/users?page=1&pageSize=10&search=Ahmet',
      headers: { 'x-test-user-id': 'admin-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.success).toBe(true)
    const data = res.payload.data as Array<{ id: string }>
    expect(data).toHaveLength(1)
    expect(data[0]!.id).toBe('teacher-1')
    expect(res.payload.pagination?.total).toBe(1)
  })

  it('prevents non-Admin Teacher from listing users', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/users',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(403)
    expect(res.payload.success).toBe(false)
  })

  it('allows Admin to update user active status and role', async () => {
    const res = await handleApiRequest({
      method: 'PATCH',
      url: 'http://localhost/api/admin/users/teacher-1',
      headers: { 'x-test-user-id': 'admin-1' },
      body: { isActive: false, role: 'ADMIN' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.success).toBe(true)
    const updated = res.payload.data as Record<string, unknown>
    expect(updated.isActive).toBe(false)
    expect(updated.role).toBe('ADMIN')
  })

  it('prevents Admin from deactivating their own account', async () => {
    const res = await handleApiRequest({
      method: 'PATCH',
      url: 'http://localhost/api/admin/users/admin-1',
      headers: { 'x-test-user-id': 'admin-1' },
      body: { isActive: false },
    }, db)

    expect(res.statusCode).toBe(422)
    expect(res.payload.success).toBe(false)
    expect(res.payload.error?.message).toContain('Kendi hesabınızı')
  })
})
