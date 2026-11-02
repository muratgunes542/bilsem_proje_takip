import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../server/auth'
import { promoteProductionAdmin, resetTeacherPasswordByAdmin } from '../server/services/admin-promotion'
import * as schema from '../server/db/schema'

describe('V1.8.3.4 Production Admin, Promotion, Password Reset & Security Tests', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `prod-v1834-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    // Insert actor admin user for foreign key audit log compliance in tests
    await db.insert(schema.users).values({
      id: 'admin-actor-1',
      name: 'Test Admin Actor',
      email: 'admin.actor@example.test',
      role: 'ADMIN',
      isActive: true,
    })
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. Creates a new admin account via promoteProductionAdmin and verifies temp password login', async () => {
    const authInstance = createAuth(db, false)
    const email = 'new.admin@example.test'

    const result = await promoteProductionAdmin(db, {
      email,
      name: 'New Admin',
      confirmation: 'PRODUCTION_CONFIRM',
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('CREATED')
    expect(result.tempPassword).toBeDefined()

    // Login with temporary password works
    const signIn = await authInstance.api.signInEmail({
      body: { email, password: result.tempPassword! },
    })
    expect(signIn.user.id).toBe(result.userId)

    const [userRow] = await db.select({ role: schema.users.role, mustChangePassword: schema.users.mustChangePassword }).from(schema.users).where(eq(schema.users.id, result.userId))
    expect(userRow?.role).toBe('ADMIN')
    expect(userRow?.mustChangePassword).toBe(true)
  })

  it('2 & 3 & 4. Promotes existing teacher to admin: role becomes ADMIN, original password & sessions are preserved', async () => {
    const authInstance = createAuth(db, false)
    const email = 'existing.teacher@example.test'
    const originalPassword = 'TeacherSecretPassword123!'

    // Create existing teacher
    const created = await authInstance.api.signUpEmail({
      body: { name: 'Existing Teacher', email, password: originalPassword },
    })
    expect(created.user).toBeDefined()

    // Create an active session for this teacher
    const existingSessionToken = randomUUID()
    await db.insert(schema.sessions).values({
      id: randomUUID(), userId: created.user.id, token: existingSessionToken, expiresAt: new Date(Date.now() + 3600000),
    })

    // Promote teacher to ADMIN
    const result = await promoteProductionAdmin(db, {
      email,
      confirmation: 'PRODUCTION_CONFIRM',
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('PROMOTED')
    expect(result.tempPassword).toBeUndefined() // Password NOT changed

    // Role is updated to ADMIN
    const [userRow] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, created.user.id))
    expect(userRow?.role).toBe('ADMIN')

    // ORIGINAL password STILL WORKS
    const signIn = await authInstance.api.signInEmail({
      body: { email, password: originalPassword },
    })
    expect(signIn.user.id).toBe(created.user.id)

    // ORIGINAL session is PRESERVED (not revoked)
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.token, existingSessionToken))
    expect(sessions).toHaveLength(1)
  })

  it('5 & 6 & 7. Admin resets teacher password: new temp password works, old fails, mustChangePassword is set, old sessions revoked', async () => {
    const authInstance = createAuth(db, false)
    const email = 'reset.teacher@example.test'
    const oldPassword = 'OldTeacherPassword123!'

    const created = await authInstance.api.signUpEmail({
      body: { name: 'Reset Teacher', email, password: oldPassword },
    })

    // Active session before reset
    const activeSessionToken = randomUUID()
    await db.insert(schema.sessions).values({
      id: randomUUID(), userId: created.user.id, token: activeSessionToken, expiresAt: new Date(Date.now() + 3600000),
    })

    // Admin resets teacher password
    const result = await resetTeacherPasswordByAdmin(db, {
      email,
      actorUserId: 'admin-actor-1',
    })

    expect(result.success).toBe(true)
    expect(result.tempPassword).toBeDefined()

    // New temp password login works
    const signIn = await authInstance.api.signInEmail({
      body: { email, password: result.tempPassword },
    })
    expect(signIn.user.id).toBe(created.user.id)

    // mustChangePassword is true
    const [userRow] = await db.select({ mustChangePassword: schema.users.mustChangePassword }).from(schema.users).where(eq(schema.users.id, created.user.id))
    expect(userRow?.mustChangePassword).toBe(true)

    // Old password fails
    await expect(authInstance.api.signInEmail({
      body: { email, password: oldPassword },
    })).rejects.toThrow()

    // Old session revoked
    const activeSessions = await db.select().from(schema.sessions).where(eq(schema.sessions.token, activeSessionToken))
    expect(activeSessions).toHaveLength(0)
  })

  it('8. Ensures atomic rollback when password reset fails (old password continues to work)', async () => {
    const authInstance = createAuth(db, false)
    const email = 'rollback.reset@example.test'
    const originalPassword = 'OriginalPass123!'

    const created = await authInstance.api.signUpEmail({
      body: { name: 'Rollback Teacher', email, password: originalPassword },
    })

    // Simulate failure during audit/transaction
    await expect(resetTeacherPasswordByAdmin(db, {
      email,
      actorUserId: 'admin-actor-1',
    }, { simulateRoleUpdateFailure: true })).rejects.toThrow()

    // Original password STILL WORKS because changes were rolled back
    const signIn = await authInstance.api.signInEmail({
      body: { email, password: originalPassword },
    })
    expect(signIn.user.id).toBe(created.user.id)
  })

  it('9. Ensures audit logs never contain plain text temporary passwords or sensitive tokens', async () => {
    const email = 'audit.clean@example.test'

    const result = await promoteProductionAdmin(db, {
      email,
      name: 'Audit Clean Admin',
      confirmation: 'PRODUCTION_CONFIRM',
    })

    const auditLogs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, result.userId))
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]?.afterJson).not.toContain(result.tempPassword!)
  })
})
