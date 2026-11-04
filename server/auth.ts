import { randomUUID } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/client.js'
import * as schema from './db/schema.js'
import { env, trustedOrigins } from './env.js'


export function createAuth(database: typeof db = db, autoSignIn = true) {
  const vercelDeploymentOrigin =
    process.env.VERCEL === '1' && process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : undefined

  const authBaseURL =
    process.env.VERCEL_ENV === 'preview' && vercelDeploymentOrigin
      ? vercelDeploymentOrigin
      : env.BETTER_AUTH_URL

  const authTrustedOrigins = vercelDeploymentOrigin
    ? [...new Set([...trustedOrigins, vercelDeploymentOrigin])]
    : trustedOrigins

  return betterAuth({
    appName: 'Kurumsal Proje Takip Sistemi',
    baseURL: authBaseURL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: authTrustedOrigins,
  database: drizzleAdapter(database, {
    provider: 'sqlite',
    schema,
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn,
    minPasswordLength: 8,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async () => {
      // No-op for programmatic password reset handling
    },
    onPasswordReset: async ({ user }) => {
      await database.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: user.id, action: 'USER_PASSWORD_RESET',
        entityType: 'USER', entityId: user.id, afterJson: JSON.stringify({ method: 'BETTER_AUTH_RESET' }),
      })
    },
  },
  user: {
    additionalFields: {
      role: {
        type: ['ADMIN', 'TEACHER'],
        required: false,
        defaultValue: 'TEACHER',
        input: false,
      },
      isActive: {
        type: 'boolean',
        required: false,
        defaultValue: true,
        input: false,
      },
      mustChangePassword: {
        type: 'boolean',
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
})
}

export const auth = createAuth()
