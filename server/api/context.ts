import type { IncomingMessage } from 'node:http'
import { and, eq, isNull } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '../db/client'
import { env } from '../env'
import type { UserRole } from '../db/schema'
import * as schema from '../db/schema'
import type { AppDatabase } from '../services/project-service'
import type { ApiContextUser } from './types'

export async function getAuthenticatedApiUser(
  req: IncomingMessage | Request | { headers: Headers | Record<string, string | string[] | undefined> },
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
      }
    }
  }

  try {
    const session = await auth.api.getSession({ headers })
    if (!session || !session.user) return null

    // Read current role and status from the database on every request. Session claims may be stale.
    const userRows = await database.select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
      isActive: schema.users.isActive,
    }).from(schema.users).where(and(eq(schema.users.id, session.user.id), isNull(schema.users.deletedAt))).limit(1)
    const currentUser = userRows[0]
    if (!currentUser) return null

    return {
      id: currentUser.id,
      role: currentUser.role as UserRole,
      isActive: Boolean(currentUser.isActive),
      name: currentUser.name,
      email: currentUser.email,
    }
  } catch {
    return null
  }
}
