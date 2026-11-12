import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser } from '../server/authorization'
import { createAuth } from '../server/auth'
import { handleApiRequest } from '../server/api/router'
import * as schema from '../server/db/schema'
import { UserService } from '../server/services/user-service'

describe('Teacher Deactivation & Admin Manual Password Reset Comprehensive Tests', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let auth: ReturnType<typeof createAuth>

  const adminId1 = 'admin-user-1'
  const adminId2 = 'admin-user-2'
  const adminId3 = 'admin-user-3'
  let teacherId1: string
  let teacherId2: string

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `teacher-deactivate-reset-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    auth = createAuth(db, false)

    // Setup Admin 1
    await db.insert(schema.users).values({
      id: adminId1,
      name: 'BİLSEM Yönetici 1',
      email: 'admin1@bilsem.test',
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
    })

    // Setup Admin 2
    await db.insert(schema.users).values({
      id: adminId2,
      name: 'BİLSEM Yönetici 2',
      email: 'admin2@bilsem.test',
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
    })

    // Setup Admin 3
    await db.insert(schema.users).values({
      id: adminId3,
      name: 'BİLSEM Yönetici 3',
      email: 'admin3@bilsem.test',
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
    })

    // Setup Teacher 1 with Better Auth account & session
    const signUp1 = await auth.api.signUpEmail({
      body: { name: 'Ahmet Öğretmen', email: 'ahmet@bilsem.test', password: 'InitialPassword123!' },
    })
    teacherId1 = signUp1.user.id
    await db.update(schema.users).set({ role: 'TEACHER', isActive: true, mustChangePassword: false }).where(eq(schema.users.id, teacherId1))

    const token1 = randomUUID()
    await db.insert(schema.sessions).values({
      id: randomUUID(),
      userId: teacherId1,
      token: token1,
      expiresAt: new Date(Date.now() + 3600000),
    })

    // Setup Teacher 2
    const signUp2 = await auth.api.signUpEmail({
      body: { name: 'Mehmet Öğretmen', email: 'mehmet@bilsem.test', password: 'InitialPassword123!' },
    })
    teacherId2 = signUp2.user.id
    await db.update(schema.users).set({ role: 'TEACHER', isActive: true, mustChangePassword: false }).where(eq(schema.users.id, teacherId2))

    // Seed academic year & projects
    await db.insert(schema.academicYears).values({
      id: 'year-2026',
      name: '2026-2027',
      startsOn: new Date('2026-09-01'),
      endsOn: new Date('2027-06-30'),
      isCurrent: true,
    })

    const [category] = await db.select().from(schema.projectCategories).limit(1)
    const [status] = await db.select().from(schema.projectStatuses).limit(1)

    await db.insert(schema.projects).values({
      id: 'proj-1',
      title: 'Biyoloji Projesi',
      academicYearId: 'year-2026',
      categoryId: category!.id,
      statusId: status!.id,
      participationType: 'INDIVIDUAL',
      createdBy: teacherId1,
    })

    await db.insert(schema.projectAdvisors).values({
      projectId: 'proj-1',
      userId: teacherId1,
      isPrimary: true,
    })

    await db.insert(schema.students).values({
      id: 'stud-1',
      bilsemNo: '1001',
      firstName: 'Ali',
      lastName: 'Yılmaz',
    })

    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-1',
      studentId: 'stud-1',
      academicYearId: 'year-2026',
      advisorUserId: teacherId1,
      advisorName: 'Ahmet Öğretmen',
    })

    await db.insert(schema.auditLogs).values({
      id: 'audit-past-1',
      actorUserId: teacherId1,
      action: 'PROJECT_CREATED',
      entityType: 'project',
      entityId: 'proj-1',
    })
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. Real Better Auth login endpoint rejects passive user with 403, creates no session, and active user login succeeds', async () => {
    // Deactivate teacher 1
    await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${teacherId1}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: false },
    }, db)

    // Existing sessions revoked
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, teacherId1))
    expect(sessions).toHaveLength(0)

    // Real Better Auth sign-in endpoint test with correct password for passive user
    const loginRes = await auth.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ahmet@bilsem.test', password: 'InitialPassword123!' }),
    }))
    expect(loginRes.status).toBe(403)
    const json = await loginRes.json() as { success: boolean; error: { message: string } }
    expect(json.success).toBe(false)
    expect(json.error.message).toContain('Hesabınız pasif durumdadır')

    // No new session created for passive user
    const sessionsAfter = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, teacherId1))
    expect(sessionsAfter).toHaveLength(0)

    // Active user (Teacher 2) sign-in via real endpoint succeeds and creates a session
    const loginRes2 = await auth.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mehmet@bilsem.test', password: 'InitialPassword123!' }),
    }))
    expect(loginRes2.status).toBe(200)
    const sessionsTeacher2 = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, teacherId2))
    expect(sessionsTeacher2.length).toBeGreaterThan(0)
  })

  it('1b. Fail-closed: Database error during active check returns 500 error response', async () => {
    // Create broken database proxy to simulate database failure during select
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          return () => { throw new Error('Simulated Database Crash') }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const brokenAuth = createAuth(brokenDb, false)

    const loginRes = await brokenAuth.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ahmet@bilsem.test', password: 'InitialPassword123!' }),
    }))

    expect(loginRes.status).toBe(500)
    const json = await loginRes.json() as { success: boolean; error: { message: string } }
    expect(json.success).toBe(false)
    expect(json.error.message).toContain('Veritabanı erişim hatası')
  })

  it('2. Independent tests: self-deactivation prohibition and last active admin protection', async () => {
    // 2a. Admin 1 deactivates Admin 2 (succeeds because Admin 3 is also active)
    const resAdmin2 = await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${adminId2}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: false },
    }, db)
    expect(resAdmin2.statusCode).toBe(200)

    // 2b. Self-deactivation rule: Admin 1 attempts to deactivate self -> rejected with 422
    const resSelf = await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${adminId1}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: false },
    }, db)
    expect(resSelf.statusCode).toBe(422)

    // Admin 1 deactivates Admin 3, leaving Admin 1 as the last active admin in DB
    const resAdmin3 = await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${adminId3}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: false },
    }, db)
    expect(resAdmin3.statusCode).toBe(200)

    // 2c. Last active admin rule: Service check prevents deactivating the last active admin
    const userService = new UserService(db)
    const staleAdminActor: AuthenticatedUser = { id: adminId2, role: 'ADMIN', isActive: true }
    await expect(userService.updateUserStatus(staleAdminActor, adminId1, { isActive: false })).rejects.toThrow('Sistemde en az bir etkin yönetici kalmalıdır')
  })

  it('3. Reactivating a passive user restores sign-in and preserves past data', async () => {
    await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${teacherId1}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: false },
    }, db)

    // Reactivate
    const res = await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${teacherId1}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: true },
    }, db)
    expect(res.statusCode).toBe(200)

    // Real Better Auth sign-in endpoint should now succeed
    const loginRes = await auth.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ahmet@bilsem.test', password: 'InitialPassword123!' }),
    }))
    expect(loginRes.status).toBe(200)

    // Past project and data are preserved
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'proj-1'))
    expect(project?.createdBy).toBe(teacherId1)
  })

  it('4. Password reset, mustChangePassword API gate, password change, and session revocation flow', async () => {
    // Passive teacher password reset must fail (400)
    await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${teacherId1}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: false },
    }, db)

    const resPassiveReset = await handleApiRequest({
      method: 'POST',
      url: `/api/admin/users/${teacherId1}/reset-password`,
      headers: { 'x-test-user-id': adminId1 },
      body: {},
    }, db)
    expect(resPassiveReset.statusCode).toBe(400)

    // Reactivate for successful reset test
    await handleApiRequest({
      method: 'PATCH',
      url: `/api/admin/users/${teacherId1}`,
      headers: { 'x-test-user-id': adminId1 },
      body: { isActive: true },
    }, db)

    // Reset password with custom temp password
    const tempPassword = 'TempPassword123!'
    const resReset = await handleApiRequest({
      method: 'POST',
      url: `/api/admin/users/${teacherId1}/reset-password`,
      headers: { 'x-test-user-id': adminId1 },
      body: { customPassword: tempPassword },
    }, db)

    expect(resReset.statusCode).toBe(200)
    const data = resReset.payload.data as { temporaryPassword: string; mustChangePassword: boolean }
    expect(data.temporaryPassword).toBe(tempPassword)
    expect(data.mustChangePassword).toBe(true)

    // Verify mustChangePassword = true in DB and sessions deleted
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, teacherId1))
    expect(user?.mustChangePassword).toBe(true)
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, teacherId1))
    expect(sessions).toHaveLength(0)

    // Audit log contains no secret password
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'TEACHER_PASSWORD_RESET'))
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs[0])).not.toContain(tempPassword)

    // Sign in via real endpoint using temporary password to get session cookie
    const loginRes = await auth.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ahmet@bilsem.test', password: tempPassword }),
    }))
    expect(loginRes.status).toBe(200)
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''

    // Protected API request rejected before password change (403)
    const deniedApi = await handleApiRequest({
      method: 'GET',
      url: '/api/students',
      headers: { 'x-test-user-id': teacherId1, cookie },
    }, db)
    expect(deniedApi.statusCode).toBe(403)
    expect(deniedApi.payload.error?.message).toContain('geçici parolanızı değiştirmelisiniz')

    // Change password via API
    const newPassword = 'BrandNewPermanentPass123!'
    const changeRes = await handleApiRequest({
      method: 'POST',
      url: '/api/account/password',
      headers: { 'x-test-user-id': teacherId1, cookie },
      body: { currentPassword: tempPassword, newPassword, newPasswordConfirmation: newPassword },
    }, db)
    expect(changeRes.statusCode).toBe(200)

    // DB reflects mustChangePassword = false
    const [updatedUser] = await db.select().from(schema.users).where(eq(schema.users.id, teacherId1))
    expect(updatedUser?.mustChangePassword).toBe(false)

    // Protected API request now succeeds (200)
    const allowedApi = await handleApiRequest({
      method: 'GET',
      url: '/api/students',
      headers: { 'x-test-user-id': teacherId1, cookie },
    }, db)
    expect(allowedApi.statusCode).toBe(200)

    // Old temporary password no longer works for sign in
    const oldLoginRes = await auth.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ahmet@bilsem.test', password: tempPassword }),
    }))
    expect(oldLoginRes.status).not.toBe(200)
  })
})
