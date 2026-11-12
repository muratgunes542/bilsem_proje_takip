import type { IncomingMessage } from 'node:http'
import { and, eq, isNull } from 'drizzle-orm'
import { createAuth } from '../auth.js'
import { db } from '../db/client.js'
import { env } from '../env.js'
import type { UserRole } from '../db/schema.js'
import * as schema from '../db/schema.js'
import type { AppDatabase } from '../services/project-service.js'
import type { ApiContextUser } from './types.js'

export async function getAuthenticatedApiUser(
  req: IncomingMessage | Request | { headers: Headers | Record<string, string | string[] | undefined>; url?: string },
  database: AppDatabase = db,
): Promise<ApiContextUser | null> {
  let headers: Headers

  if ('headers' in req && req.headers instanceof Headers) {
    headers = req.headers
  } else if ('headers' in req && req.headers) {
    headers = new Headers()
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === 'string') headers.set(key, val)
      else if (Array.isArray(val)) headers.set(key, val.join(', '))
    }
  } else {
    headers = new Headers()
  }

  // This test-only identity hook is disabled unless the application explicitly runs in test mode.
  const testUserId = headers.get('x-test-user-id')
  if (env.APP_ENV === 'test' && testUserId) {
    const userRows = await database
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.users.role,
        isActive: schema.users.isActive,
        mustChangePassword: schema.users.mustChangePassword,
      })
      .from(schema.users)
      .where(and(eq(schema.users.id, testUserId), isNull(schema.users.deletedAt)))
      .limit(1)

    if (userRows[0]) {
      return {
        id: userRows[0].id,
        role: userRows[0].role as UserRole,
        isActive: Boolean(userRows[0].isActive),
        name: userRows[0].name,
        email: userRows[0].email,
        mustChangePassword: Boolean(userRows[0].mustChangePassword),
      }
    }
  }

  try {
    const authInstance = createAuth(database as unknown as typeof db)
    const session = await authInstance.api.getSession({ headers })
    if (!session || !session.user || !session.session) return null

    // Fail-closed user active check
    const userRows = await database.select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
      isActive: schema.users.isActive,
      mustChangePassword: schema.users.mustChangePassword,
    }).from(schema.users).where(and(eq(schema.users.id, session.user.id), isNull(schema.users.deletedAt))).limit(1)

    const currentUser = userRows[0]
    if (!currentUser) return null
    if (!currentUser.isActive) {
      await database.delete(schema.sessions).where(eq(schema.sessions.userId, session.user.id))
      return {
        id: currentUser.id,
        role: currentUser.role as UserRole,
        isActive: false,
        name: currentUser.name,
        email: currentUser.email,
        mustChangePassword: Boolean(currentUser.mustChangePassword),
      }
    }

    // Verify session record and 60-minute idle timeout in sessions table
    const [sessionRow] = await database.select({
      id: schema.sessions.id,
      createdAt: schema.sessions.createdAt,
      lastActiveAt: schema.sessions.lastActiveAt,
    }).from(schema.sessions).where(eq(schema.sessions.id, session.session.id)).limit(1)

    if (!sessionRow) return null

    const lastActiveTime = sessionRow.lastActiveAt ? new Date(sessionRow.lastActiveAt).getTime() : new Date(sessionRow.createdAt).getTime()
    const IDLE_LIMIT_MS = 60 * 60 * 1000 // 60 minutes
    if (Date.now() - lastActiveTime > IDLE_LIMIT_MS) {
      await database.delete(schema.sessions).where(eq(schema.sessions.id, session.session.id))
      return null
    }

    // Initialize lastActiveAt if null
    if (!sessionRow.lastActiveAt) {
      await database.update(schema.sessions)
        .set({ lastActiveAt: new Date(sessionRow.createdAt) })
        .where(eq(schema.sessions.id, session.session.id))
    }

    // Determine if request is interactive vs background
    let requestUrl = ''
    if ('url' in req && typeof req.url === 'string') {
      requestUrl = req.url
    }

    const isInteractive = (() => {
      const path = requestUrl.split('?')[0] ?? ''
      if (path === '/api/notifications' || path.startsWith('/api/notifications/')) return false
      return true
    })()

    // 5-minute throttle for updating lastActiveAt on interactive requests
    if (isInteractive) {
      const THROTTLE_MS = 5 * 60 * 1000 // 5 minutes
      if (!sessionRow.lastActiveAt || (Date.now() - new Date(sessionRow.lastActiveAt).getTime() > THROTTLE_MS)) {
        await database.update(schema.sessions)
          .set({ lastActiveAt: new Date() })
          .where(eq(schema.sessions.id, session.session.id))
      }
    }

    return {
      id: currentUser.id,
      role: currentUser.role as UserRole,
      isActive: Boolean(currentUser.isActive),
      name: currentUser.name,
      email: currentUser.email,
      mustChangePassword: Boolean(currentUser.mustChangePassword),
    }
  } catch {
    return null
  }
}
