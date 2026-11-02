import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../server/auth'
import { handleApiRequest } from '../server/api/router'
import * as schema from '../server/db/schema'

describe('Admin-created teacher credentials and first sign-in gate', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `teacher-account-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    await db.insert(schema.users).values([
      { id: 'TEST-admin', name: 'TEST Admin', email: 'admin-v161@example.com', role: 'ADMIN' },
      { id: 'TEST-teacher', name: 'TEST Teacher', email: 'teacher-v161@example.com', role: 'TEACHER' },
    ])
  })
  afterEach(async () => { await client.close() })

  it('creates a Better Auth teacher with an undisclosed role, one-time password, and forced-change audit', async () => {
    const response = await handleApiRequest({ method: 'POST', url: '/api/admin/teachers', headers: { 'x-test-user-id': 'TEST-admin' }, body: { name: 'TEST Yeni Öğretmen', email: 'new-v161@example.com' } }, db)
    expect(response.statusCode).toBe(201)
    const data = response.payload.data as { user: { id: string; role: string; mustChangePassword: boolean }; temporaryPassword: string }
    expect(data.user.role).toBe('TEACHER')
    expect(data.user.mustChangePassword).toBe(true)
    expect(data.temporaryPassword).toHaveLength(36)
    const user = await db.select().from(schema.users).where((await import('drizzle-orm')).eq(schema.users.id, data.user.id))
    expect(user[0]?.mustChangePassword).toBe(true)
    expect(user[0]?.role).toBe('TEACHER')
    expect(await db.select().from(schema.sessions)).toHaveLength(0)
    expect(await db.select().from(schema.students)).toHaveLength(0)
    const account = await db.select().from(schema.accounts).where((await import('drizzle-orm')).eq(schema.accounts.userId, data.user.id))
    expect(account[0]?.password).not.toBe(data.temporaryPassword)
    const logs = await db.select().from(schema.auditLogs).where((await import('drizzle-orm')).eq(schema.auditLogs.entityId, data.user.id))
    expect(logs).toMatchObject([{ action: 'TEACHER_ACCOUNT_CREATED' }])
    expect(JSON.stringify(logs)).not.toContain(data.temporaryPassword)
    const duplicateEmail = await handleApiRequest({ method: 'POST', url: '/api/admin/teachers', headers: { 'x-test-user-id': 'TEST-admin' }, body: { name: 'TEST Mükerrer', email: 'new-v161@example.com' } }, db)
    expect(duplicateEmail.statusCode).toBe(422)
    const profile = await handleApiRequest({ method: 'GET', url: '/api/me', headers: { 'x-test-user-id': data.user.id } }, db)
    expect(profile.statusCode).toBe(200)
    expect(profile.payload.data).toMatchObject({ mustChangePassword: true })
    const denied = await handleApiRequest({ method: 'GET', url: '/api/students', headers: { 'x-test-user-id': data.user.id } }, db)
    expect(denied.statusCode).toBe(403)
    expect(denied.payload.error?.message).toContain('geçici parolanızı değiştirmelisiniz')
    const auth = createAuth(db, false)
    const signIn = await auth.api.signInEmail({ body: { email: 'new-v161@example.com', password: data.temporaryPassword } })
    expect(signIn.user.email).toBe('new-v161@example.com')
    const loginResponse = await auth.handler(new Request('http://localhost/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new-v161@example.com', password: data.temporaryPassword }) }))
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).toContain('better-auth.session_token=')
    const otherAccountChange = await handleApiRequest({ method: 'POST', url: '/api/account/password', headers: { 'x-test-user-id': 'TEST-teacher', cookie }, body: { currentPassword: data.temporaryPassword, newPassword: 'YeniParola8', newPasswordConfirmation: 'YeniParola8' } }, db)
    expect(otherAccountChange.statusCode).toBe(401)
    const wrongCurrent = await handleApiRequest({ method: 'POST', url: '/api/account/password', headers: { 'x-test-user-id': data.user.id, cookie }, body: { currentPassword: 'YanlisParola9', newPassword: 'YeniParola8', newPasswordConfirmation: 'YeniParola8' } }, db)
    expect(wrongCurrent.statusCode).toBe(422)
    const mismatch = await handleApiRequest({ method: 'POST', url: '/api/account/password', headers: { 'x-test-user-id': data.user.id, cookie }, body: { currentPassword: data.temporaryPassword, newPassword: 'YeniParola8', newPasswordConfirmation: 'Uyusmuyor8' } }, db)
    expect(mismatch.statusCode).toBe(400)
    const changed = await handleApiRequest({ method: 'POST', url: '/api/account/password', headers: { 'x-test-user-id': data.user.id, cookie }, body: { currentPassword: data.temporaryPassword, newPassword: 'YeniParola8', newPasswordConfirmation: 'YeniParola8' } }, db)
    expect(changed.statusCode).toBe(200)
    expect(await createAuth(db).api.getSession({ headers: new Headers({ cookie }) })).toBeNull()
    const refreshedCookie = changed.responseHeaders?.get('set-cookie')?.split(';')[0] ?? ''
    expect(refreshedCookie).toContain('better-auth.session_token=')
    expect(await createAuth(db).api.getSession({ headers: new Headers({ cookie: refreshedCookie }) })).toMatchObject({ user: { id: data.user.id } })
    expect((await db.select().from(schema.users).where((await import('drizzle-orm')).eq(schema.users.id, data.user.id)))[0]?.mustChangePassword).toBe(false)
    const newSignIn = await createAuth(db, false).api.signInEmail({ body: { email: 'new-v161@example.com', password: 'YeniParola8' } })
    expect(newSignIn.user.email).toBe('new-v161@example.com')
  })

  it('does not let a teacher create another account and rejects invalid or duplicate email input', async () => {
    const forbidden = await handleApiRequest({ method: 'POST', url: '/api/admin/teachers', headers: { 'x-test-user-id': 'TEST-teacher' }, body: { name: 'TEST Yetkisiz', email: 'x@test.invalid' } }, db)
    expect(forbidden.statusCode).toBe(403)
    const invalid = await handleApiRequest({ method: 'POST', url: '/api/admin/teachers', headers: { 'x-test-user-id': 'TEST-admin' }, body: { name: 'TEST Eksik', email: 'not-an-email' } }, db)
    expect(invalid.statusCode).toBe(400)
    const forgedRole = await handleApiRequest({ method: 'POST', url: '/api/admin/teachers', headers: { 'x-test-user-id': 'TEST-admin' }, body: { name: 'TEST Rol', email: 'role@example.com', role: 'ADMIN' } }, db)
    expect(forgedRole.statusCode).toBe(400)
  })
})
