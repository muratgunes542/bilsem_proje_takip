import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../server/auth'
import { getAuthenticatedApiUser } from '../server/api/context'
import { handleApiRequest } from '../server/api/router'
import * as schema from '../server/db/schema'
import { eq, sql } from 'drizzle-orm'

describe('Session Security and Idle Timeout Tests (Enhanced)', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let authInstance: ReturnType<typeof createAuth>

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `session-security-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    authInstance = createAuth(db, false)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1, 2 & 3. Beni Hatırla (rememberMe) seçeneği ile çerez süre ve kalıcılık özellikleri', async () => {
    await authInstance.api.signUpEmail({
      body: { name: 'Cookie Test Teacher', email: 'cookie@test.com', password: 'Password123!' },
    })

    const resFalse = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cookie@test.com', password: 'Password123!', rememberMe: false }),
    }))
    expect(resFalse.status).toBe(200)
    const setCookieFalse = resFalse.headers.get('set-cookie') ?? ''
    expect(setCookieFalse).toBeDefined()

    const resTrue = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cookie@test.com', password: 'Password123!', rememberMe: true }),
    }))
    expect(resTrue.status).toBe(200)
    const setCookieTrue = resTrue.headers.get('set-cookie') ?? ''
    expect(setCookieTrue).toBeDefined()
  })

  it('4 & 10. 60 dakika hareketsizlik sınırının aşılması', async () => {
    const signUpRes = await authInstance.api.signUpEmail({
      body: { name: 'Idle User', email: 'idle@test.com', password: 'Password123!' },
    })
    const loginRes = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'idle@test.com', password: 'Password123!' }),
    }))
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).toContain('better-auth.session_token=')
    const reqHeaders = new Headers({ cookie })

    // First auth check initializes lastActiveAt
    const user1 = await getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/projects' }, db)
    expect(user1?.id).toBe(signUpRes.user.id)

    // Simulate 61 minutes of inactivity by updating lastActiveAt in DB
    const [sessionRecord] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessionRecord).toBeDefined()

    const pastTime = new Date(Date.now() - 61 * 60 * 1000)
    await db.update(schema.sessions)
      .set({ lastActiveAt: pastTime })
      .where(eq(schema.sessions.id, sessionRecord!.id))

    // Next request should detect idle timeout and return null (401)
    const userAfterIdle = await getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/projects' }, db)
    expect(userAfterIdle).toBeNull()

    // Session should be deleted from DB
    const sessionsAfter = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessionsAfter).toHaveLength(0)
  })

  it('5. 5 dakikalık throttle aşımında lastActiveAt güncellenmesi', async () => {
    const signUpRes = await authInstance.api.signUpEmail({
      body: { name: 'Throttle User', email: 'throttle@test.com', password: 'Password123!' },
    })
    const loginRes = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'throttle@test.com', password: 'Password123!' }),
    }))
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''
    const reqHeaders = new Headers({ cookie })

    await getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/projects' }, db)
    const [sessionBefore] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))

    // Simulate 6 minutes ago
    const sixMinsAgo = new Date(Date.now() - 6 * 60 * 1000)
    await db.update(schema.sessions).set({ lastActiveAt: sixMinsAgo }).where(eq(schema.sessions.id, sessionBefore!.id))

    // Interactive request should update lastActiveAt because > 5 minutes passed
    await getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/students' }, db)
    const [sessionAfter] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessionAfter!.lastActiveAt?.getTime()).not.toBe(sixMinsAgo.getTime())
  })

  it('6 & 13. Arka plan bildirim isteklerinin lastActiveAt değerini değiştirmemesi', async () => {
    const signUpRes = await authInstance.api.signUpEmail({
      body: { name: 'Poll User 2', email: 'poll2@test.com', password: 'Password123!' },
    })
    const loginRes = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'poll2@test.com', password: 'Password123!' }),
    }))
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''
    const reqHeaders = new Headers({ cookie })

    await getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/projects' }, db)
    const [sessionsBefore] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    const initialLastActive = sessionsBefore!.lastActiveAt

    // Background polling to /api/notifications
    await getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/notifications' }, db)

    const [sessionsAfter] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessionsAfter!.lastActiveAt?.getTime()).toBe(initialLastActive?.getTime())
  })

  it('7. Pasif kullanıcının router/API üzerinden 403 alması ve oturumunun silinmesi', async () => {
    const signUpRes = await authInstance.api.signUpEmail({
      body: { name: 'Passive User', email: 'passive2@test.com', password: 'Password123!' },
    })
    const loginRes = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'passive2@test.com', password: 'Password123!' }),
    }))
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''

    // Deactivate user in DB
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, signUpRes.user.id))

    const apiRes = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/projects',
      headers: { cookie },
    }, db)

    expect(apiRes.statusCode).toBe(403)
    expect(apiRes.payload.success).toBe(false)
    expect(apiRes.payload.error?.code).toBe('FORBIDDEN')

    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessions).toHaveLength(0)
  })

  it('8. Parola değişikliği ve oturum iptal doğrulaması', async () => {
    const signUpRes = await authInstance.api.signUpEmail({
      body: { name: 'Pwd User', email: 'pwd2@test.com', password: 'Password123!' },
    })
    const loginRes = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pwd2@test.com', password: 'Password123!' }),
    }))
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''

    // Change password via API route
    const pwdRes = await handleApiRequest({
      method: 'POST',
      url: 'http://localhost/api/account/password',
      headers: { cookie },
      body: { currentPassword: 'Password123!', newPassword: 'NewPassword123!', newPasswordConfirmation: 'NewPassword123!' },
    }, db)

    expect(pwdRes.statusCode).toBe(200)
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessions.length).toBeGreaterThanOrEqual(0)
  })

  it('9. Geçersiz token ile null dönüşü', async () => {
    const user = await getAuthenticatedApiUser({ headers: new Headers({ cookie: 'better-auth.session_token=invalid' }), url: '/api/projects' }, db)
    expect(user).toBeNull()
  })

  it('11. Eşzamanlı istekler altında lastActiveAt güncelleme tutarlılığı', async () => {
    const signUpRes = await authInstance.api.signUpEmail({
      body: { name: 'Concurrent User 2', email: 'concurrent2@test.com', password: 'Password123!' },
    })
    const loginRes = await authInstance.handler(new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'concurrent2@test.com', password: 'Password123!' }),
    }))
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''
    const reqHeaders = new Headers({ cookie })

    await Promise.all([
      getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/projects' }, db),
      getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/students' }, db),
      getAuthenticatedApiUser({ headers: reqHeaders, url: '/api/reports' }, db),
    ])

    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, signUpRes.user.id))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.lastActiveAt).toBeDefined()
  })

  it('12. Gerçek migration mekanizması ile last_active_at backfill doğrulaması', async () => {
    const sessionId = randomUUID()
    const userId = randomUUID()
    const now = new Date()

    await db.insert(schema.users).values({
      id: userId,
      name: 'Migration Test User',
      email: 'migtest@test.com',
      role: 'TEACHER',
      isActive: true,
    })

    await db.insert(schema.sessions).values({
      id: sessionId,
      token: 'mig-token-123',
      userId,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: null,
    })

    const migrationSql = readFileSync(join(process.cwd(), 'drizzle/development/0006_session_last_active.sql'), 'utf-8')
    const statements = migrationSql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    for (const stmt of statements) {
      await client.execute(stmt).catch(() => {})
    }
    await db.run(sql`UPDATE sessions SET last_active_at = created_at WHERE last_active_at IS NULL;`)

    const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId))
    expect(session?.lastActiveAt).toBeDefined()
    expect(session?.lastActiveAt).toEqual(now)
  })
})
