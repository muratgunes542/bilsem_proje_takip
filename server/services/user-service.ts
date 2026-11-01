import { randomUUID } from 'node:crypto'
import { and, count, eq, isNull, like, or } from 'drizzle-orm'
import { AuthorizationError, canManageAllRecords, type AuthenticatedUser } from '../authorization'
import * as schema from '../db/schema'
import type { AppDatabase } from './project-service'

export class UserRuleError extends Error {
  readonly statusCode = 422
}

export type ListUsersOptions = {
  page?: number
  pageSize?: number
  search?: string
  role?: schema.UserRole
}

export class UserService {
  constructor(private readonly database: AppDatabase) {}

  async getCurrentUserProfile(actor: AuthenticatedUser) {
    if (!actor || !actor.isActive) throw new AuthorizationError()

    const rows = await this.database
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.users.role,
        isActive: schema.users.isActive,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(and(eq(schema.users.id, actor.id), isNull(schema.users.deletedAt)))
      .limit(1)

    if (!rows[0]) throw new AuthorizationError('Kullanıcı bulunamadı.')
    return rows[0]
  }

  async listUsers(actor: AuthenticatedUser, options: ListUsersOptions = {}) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Kullanıcıları listeleme yetkiniz yok.')

    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20))
    const offset = (page - 1) * pageSize

    const conditions = [isNull(schema.users.deletedAt)]

    if (options.role) {
      conditions.push(eq(schema.users.role, options.role))
    }

    if (options.search?.trim()) {
      const term = `%${options.search.trim()}%`
      conditions.push(or(like(schema.users.name, term), like(schema.users.email, term))!)
    }

    const whereClause = and(...conditions)

    const [totalRow] = await this.database
      .select({ total: count() })
      .from(schema.users)
      .where(whereClause)

    const total = totalRow?.total ?? 0
    const totalPages = Math.ceil(total / pageSize)

    const rows = await this.database
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.users.role,
        isActive: schema.users.isActive,
        createdAt: schema.users.createdAt,
        updatedAt: schema.users.updatedAt,
      })
      .from(schema.users)
      .where(whereClause)
      .limit(pageSize)
      .offset(offset)

    return {
      users: rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    }
  }

  async updateUserStatus(actor: AuthenticatedUser, targetUserId: string, updates: { role?: schema.UserRole; isActive?: boolean }) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Kullanıcı güncelleme yetkiniz yok.')

    if (targetUserId === actor.id && updates.isActive === false) {
      throw new UserRuleError('Kendi hesabınızı pasif duruma getiremezsiniz.')
    }

    return this.database.transaction(async (transaction) => {
      const existing = await transaction
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, targetUserId), isNull(schema.users.deletedAt)))
        .limit(1)

      if (!existing[0]) {
        const error = new UserRuleError('Güncellenecek kullanıcı bulunamadı.')
        Object.assign(error, { statusCode: 404 })
        throw error
      }

      await transaction
        .update(schema.users)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, targetUserId))

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'USER_UPDATED',
        entityType: 'USER',
        entityId: targetUserId,
        beforeJson: JSON.stringify({ role: existing[0].role, isActive: existing[0].isActive }),
        afterJson: JSON.stringify(updates),
      })

      const [updated] = await transaction
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.users.role,
          isActive: schema.users.isActive,
          updatedAt: schema.users.updatedAt,
        })
        .from(schema.users)
        .where(eq(schema.users.id, targetUserId))

      return updated
    })
  }
}
