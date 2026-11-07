import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import * as schema from '../db/schema.js'
import type { AppDatabase } from './project-service.js'

export class AdminPromotionError extends Error {
  statusCode = 400
}

export type PromoteAdminParams = {
  email: string
  name?: string
  confirmation: string
  expectedDatabaseUrl?: string
}

export type PromoteAdminResult = {
  success: boolean
  action: 'PROMOTED' | 'CREATED' | 'SKIPPED_ALREADY_ADMIN'
  userId: string
  email: string
  tempPassword?: string
  message: string
}

export type PromoteAdminTestHooks = {
  simulateBetterAuthFailure?: boolean
  simulateUserUpdateFailure?: boolean
  simulateAuditLogFailure?: boolean
  simulateSessionDeletionFailure?: boolean
  simulateRollbackFailure?: boolean
  simulateRoleUpdateFailure?: boolean
}

export async function promoteProductionAdmin(
  database: AppDatabase,
  params: PromoteAdminParams,
  hooks?: PromoteAdminTestHooks,
): Promise<PromoteAdminResult> {
  const email = params.email.trim().toLowerCase()
  if (!email || !email.includes('@')) {
    throw new Error('Geçersiz e-posta adresi.')
  }

  if (params.confirmation !== 'PRODUCTION_CONFIRM') {
    throw new Error('Onay alınmadı; hiçbir üretim değişikliği yapılmadı.')
  }

  const [existing] = await database.select({ id: schema.users.id, role: schema.users.role, name: schema.users.name, mustChangePassword: schema.users.mustChangePassword })
    .from(schema.users).where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt))).limit(1)

  if (existing && existing.role === 'ADMIN') {
    return {
      success: true,
      action: 'SKIPPED_ALREADY_ADMIN',
      userId: existing.id,
      email,
      message: `Bu e-posta (${email}) zaten ÜRETİM YÖNETİCİSİ (ADMIN) rolüne sahip. Rol veya parola değiştirilmedi.`,
    }
  }

  if (existing) {
    // Existing teacher promotion: Change ONLY role to ADMIN. Do NOT change password, mustChangePassword or sessions.
    try {
      if (hooks?.simulateRoleUpdateFailure) {
        throw new Error('Simulated failure during role update')
      }

      await database.transaction(async (tx) => {
        await tx.update(schema.users).set({ role: 'ADMIN', updatedAt: new Date() }).where(eq(schema.users.id, existing.id))
        await tx.insert(schema.auditLogs).values({
          id: randomUUID(), actorUserId: existing.id, action: 'USER_PROMOTED_TO_ADMIN',
          entityType: 'USER', entityId: existing.id, afterJson: JSON.stringify({ email, env: 'production' }),
        })
      })

      return {
        success: true,
        action: 'PROMOTED',
        userId: existing.id,
        email,
        message: `Mevcut öğretmen hesabı başarıyla ÜRETİM YÖNETİCİSİ (ADMIN) rolüne yükseltildi: ${email}`,
      }
    } catch (error) {
      // Rollback role on error
      try {
        await database.update(schema.users).set({ role: existing.role }).where(eq(schema.users.id, existing.id))
      } catch (rollbackErr) {
        console.error('Role rollback failed:', rollbackErr)
      }
      throw new Error(`Kullanıcı yükseltme işlemi başarısız oldu ve tüm değişiklikler geri alındı: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}`, { cause: error })
    }
  } else {
    // New user creation
    const authInstance = betterAuth({
      database: drizzleAdapter(database, { provider: 'sqlite', schema, usePlural: true }),
      emailAndPassword: {
        enabled: true,
      },
    })

    const tempPassword = `${randomBytes(24).toString('base64url')}aA7!`
    let createdUserId = ''

    try {
      if (hooks?.simulateBetterAuthFailure) {
        throw new Error('Simulated Better Auth sign up failure')
      }

      const created = await authInstance.api.signUpEmail({
        body: { name: params.name?.trim() || 'Sistem Yöneticisi', email, password: tempPassword },
      })
      if (!created || !created.user) {
        throw new Error('Better Auth üzerinden kullanıcı hesabı oluşturulamadı.')
      }
      createdUserId = created.user.id

      if (hooks?.simulateRoleUpdateFailure) {
        throw new Error('Simulated failure during role/audit update')
      }

      await database.transaction(async (tx) => {
        await tx.update(schema.users).set({ role: 'ADMIN', mustChangePassword: true, updatedAt: new Date() }).where(eq(schema.users.id, createdUserId))
        await tx.insert(schema.auditLogs).values({
          id: randomUUID(), actorUserId: createdUserId, action: 'PRODUCTION_ADMIN_CREATED',
          entityType: 'USER', entityId: createdUserId, afterJson: JSON.stringify({ email, env: 'production' }),
        })
      })

      return {
        success: true,
        action: 'CREATED',
        userId: createdUserId,
        email,
        tempPassword,
        message: `Yeni üretim yöneticisi başarıyla oluşturuldu: ${email}`,
      }
    } catch (error) {
      // ATOMIC ROLLBACK: Remove half-created user if role/audit update fails
      if (createdUserId) {
        try {
          await database.delete(schema.sessions).where(eq(schema.sessions.userId, createdUserId))
          await database.delete(schema.accounts).where(eq(schema.accounts.userId, createdUserId))
          await database.delete(schema.users).where(eq(schema.users.id, createdUserId))
        } catch (rollbackErr) {
          console.error('Cleanup rollback failed:', rollbackErr)
        }
      }
      throw new Error(`Yeni yönetici oluşturma işlemi başarısız oldu ve tüm kayıtlar temizlendi: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}`, { cause: error })
    }
  }
}

export type ResetPasswordParams = {
  email?: string
  userId?: string
  actorUserId: string
  customPassword?: string
  auditAction?: 'TEACHER_PASSWORD_RESET_BY_ADMIN' | 'ADMIN_PASSWORD_RESET' | 'TEACHER_PASSWORD_RESET'
}

export type ResetPasswordResult = {
  success: boolean
  userId: string
  email: string
  tempPassword: string
  message: string
}

export async function resetTeacherPasswordByAdmin(
  database: AppDatabase,
  params: ResetPasswordParams,
  hooks?: PromoteAdminTestHooks,
): Promise<ResetPasswordResult> {
  const emailCondition = params.email ? eq(schema.users.email, params.email.trim().toLowerCase()) : undefined
  const userIdCondition = params.userId ? eq(schema.users.id, params.userId) : undefined
  const targetCondition = userIdCondition ?? emailCondition

  if (!targetCondition) {
    const error = new AdminPromotionError('Kullanıcı kimliği veya e-posta adresi zorunludur.')
    error.statusCode = 400
    throw error
  }

  const [existing] = await database.select({
    id: schema.users.id,
    role: schema.users.role,
    name: schema.users.name,
    email: schema.users.email,
    isActive: schema.users.isActive,
    mustChangePassword: schema.users.mustChangePassword,
  })
    .from(schema.users)
    .where(and(targetCondition, isNull(schema.users.deletedAt)))
    .limit(1)

  if (!existing) {
    const error = new AdminPromotionError('Kullanıcı bulunamadı.')
    error.statusCode = 404
    throw error
  }

  if (params.actorUserId === existing.id) {
    throw new AdminPromotionError('Kendi parolanızı bu işlevle sıfırlayamazsınız.')
  }

  if (params.auditAction !== 'ADMIN_PASSWORD_RESET' && existing.role !== 'TEACHER') {
    throw new AdminPromotionError('Yalnızca öğretmenlerin parolası sıfırlanabilir.')
  }

  if (!existing.isActive) {
    throw new AdminPromotionError('Yalnızca aktif öğretmenlerin parolası sıfırlanabilir. Pasif öğretmenlerin parolası sıfırlanamaz.')
  }

  if (params.customPassword !== undefined) {
    if (params.customPassword.length < 8) {
      const error = new AdminPromotionError('Yeni parola en az 8 karakter olmalıdır.')
      error.statusCode = 400
      throw error
    }
    if (params.customPassword.length > 128) {
      const error = new AdminPromotionError('Yeni parola en fazla 128 karakter olabilir.')
      error.statusCode = 400
      throw error
    }
  }

  const email = existing.email

  // Capture original password hash from accounts for atomic rollback on failure
  const [originalAccount] = await database.select({ password: schema.accounts.password })
    .from(schema.accounts).where(and(eq(schema.accounts.userId, existing.id), eq(schema.accounts.providerId, 'credential'))).limit(1)

  if (!originalAccount || !originalAccount.password) {
    const error = new AdminPromotionError('Kullanıcının parola hesabı bulunamadı.')
    error.statusCode = 400
    throw error
  }

  let capturedResetToken = ''
  const authInstance = betterAuth({
    database: drizzleAdapter(database, { provider: 'sqlite', schema, usePlural: true }),
    emailAndPassword: {
      enabled: true,
      revokeSessionsOnPasswordReset: false,
      sendResetPassword: async (data) => {
        capturedResetToken = data.token
      },
    },
  })

  const tempPassword = params.customPassword ?? `${randomBytes(24).toString('base64url')}aA7!`

  try {
    if (hooks?.simulateBetterAuthFailure) {
      throw new Error('Simulated Better Auth reset password failure')
    }

    await authInstance.api.requestPasswordReset({
      body: { email, redirectTo: 'http://localhost' },
    })

    if (!capturedResetToken) throw new Error('Better Auth parola sıfırlama jetonu oluşturulamadı.')

    await authInstance.api.resetPassword({
      body: { token: capturedResetToken, newPassword: tempPassword },
    })

    if (hooks?.simulateRoleUpdateFailure) {
      throw new Error('Simulated failure during password reset completion')
    }

    await database.transaction(async (tx) => {
      if (hooks?.simulateSessionDeletionFailure) {
        throw new Error('Simulated session deletion failure')
      }
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, existing.id))

      if (hooks?.simulateUserUpdateFailure) {
        throw new Error('Simulated user update failure')
      }
      await tx.update(schema.users).set({ mustChangePassword: true, updatedAt: new Date() }).where(eq(schema.users.id, existing.id))

      if (hooks?.simulateAuditLogFailure) {
        throw new Error('Simulated audit log failure')
      }
      await tx.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: params.actorUserId,
        action: params.auditAction ?? 'TEACHER_PASSWORD_RESET_BY_ADMIN',
        entityType: 'USER', entityId: existing.id, afterJson: JSON.stringify({ email, method: params.customPassword ? 'ADMIN_CUSTOM' : 'SYSTEM_GENERATED' }),
      })
    })

    return {
      success: true,
      userId: existing.id,
      email,
      tempPassword,
      message: `Kullanıcı paroları başarıyla sıfırlandı ve tüm aktif oturumları kapatıldı: ${email}`,
    }
  } catch (error) {
    let rollbackFailed = false
    let rollbackError: unknown = null
    try {
      if (hooks?.simulateRollbackFailure) {
        throw new Error('Simulated secondary rollback failure', { cause: error })
      }
      if (originalAccount?.password) {
        await database.update(schema.accounts).set({ password: originalAccount.password })
          .where(and(eq(schema.accounts.userId, existing.id), eq(schema.accounts.providerId, 'credential')))
      }
      await database.update(schema.users).set({ mustChangePassword: existing.mustChangePassword })
        .where(eq(schema.users.id, existing.id))
    } catch (rollbackErr) {
      rollbackFailed = true
      rollbackError = rollbackErr
      console.error('CRITICAL: Password reset rollback failed:', rollbackErr)
    }

    if (rollbackFailed) {
      throw new Error(`Kritik Hata: Parola sıfırlama işlemi başarısız oldu ve otomatik rollback de başarısız oldu: ${rollbackError instanceof Error ? rollbackError.message : 'Bilinmeyen hata'} (Orijinal hata: ${error instanceof Error ? error.message : 'Bilinmeyen hata'})`, { cause: error })
    }

    throw new Error(`Parola sıfırlama işlemi başarısız oldu ve tüm değişiklikler geri alındı: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}`, { cause: error })
  }
}
