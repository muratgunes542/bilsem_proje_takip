import { and, desc, eq } from 'drizzle-orm'
import { AuthorizationError, canReadNotification, type AuthenticatedUser } from '../authorization'
import * as schema from '../db/schema'
import type { AppDatabase } from './project-service'

export class NotificationService {
  constructor(private readonly database: AppDatabase) {}

  async listForUser(user: AuthenticatedUser) {
    if (!user.isActive) throw new AuthorizationError()
    return this.database.select().from(schema.notifications)
      .where(eq(schema.notifications.recipientId, user.id))
      .orderBy(desc(schema.notifications.createdAt))
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
