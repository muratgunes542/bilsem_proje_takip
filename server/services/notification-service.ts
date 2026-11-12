import { and, count, desc, eq } from 'drizzle-orm'
import { AuthorizationError, canReadNotification, type AuthenticatedUser } from '../authorization.js'
import * as schema from '../db/schema.js'
import type { AppDatabase } from './project-service.js'

export class NotificationService {
  constructor(private readonly database: AppDatabase) {}

  async listForUser(user: AuthenticatedUser, options: { page?: number; pageSize?: number; unreadOnly?: boolean } = {}) {
    if (!user.isActive) throw new AuthorizationError()
    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20))
    const conditions = [eq(schema.notifications.recipientId, user.id)]
    if (options.unreadOnly) conditions.push(eq(schema.notifications.isRead, false))
    const where = and(...conditions)
    const [totalRow] = await this.database.select({ total: count() }).from(schema.notifications).where(where)
    const notifications = await this.database.select({
      id: schema.notifications.id,
      projectId: schema.notifications.projectId,
      type: schema.notifications.type,
      title: schema.notifications.title,
      message: schema.notifications.message,
      isRead: schema.notifications.isRead,
      createdAt: schema.notifications.createdAt,
    }).from(schema.notifications)
      .where(where)
      .orderBy(desc(schema.notifications.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
    const total = totalRow?.total ?? 0
    return { notifications, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
  }

  async markAsRead(user: AuthenticatedUser, notificationId: string) {
    const notification = await this.database.select({ recipientId: schema.notifications.recipientId })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notificationId))
      .limit(1)

    if (!notification[0] || !canReadNotification(user, notification[0].recipientId)) {
      throw new AuthorizationError('Bu bildirime erişim yetkiniz yok.')
    }

    await this.database.update(schema.notifications).set({ isRead: true })
      .where(and(eq(schema.notifications.id, notificationId), eq(schema.notifications.recipientId, user.id)))
  }
}
