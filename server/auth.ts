import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
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

  const productionVercelUrl = 'https://bilsemprojetakip.vercel.app'

  const authBaseURL =
    process.env.VERCEL_ENV === 'preview' && vercelDeploymentOrigin
      ? vercelDeploymentOrigin
      : env.BETTER_AUTH_URL

  const authTrustedOrigins = [
    ...new Set([
      ...trustedOrigins,
      productionVercelUrl,
      ...(vercelDeploymentOrigin ? [vercelDeploymentOrigin] : []),
    ]),
  ]

  const authInstance = betterAuth({
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
      revokeSessionsOnPasswordReset: false,
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

  const originalHandler = authInstance.handler
  authInstance.handler = async (request: Request) => {
    const url = new URL(request.url)
    const isSignInEmail =
      request.method.toUpperCase() === 'POST' &&
      (url.pathname === '/api/auth/sign-in/email' || url.pathname.endsWith('/sign-in/email'))

    if (isSignInEmail) {
      let email: string | undefined
      try {
        const cloned = request.clone()
        const body = (await cloned.json().catch(() => null)) as { email?: string } | null
        email = body?.email?.trim()?.toLowerCase()
      } catch {
        // Unparseable JSON body -> pass to Better Auth's own validation
      }

      if (email) {
        let userRow: { isActive: boolean } | undefined
        try {
          const [row] = await database
            .select({ isActive: schema.users.isActive })
            .from(schema.users)
            .where(eq(schema.users.email, email))
            .limit(1)
          userRow = row
        } catch {
          // FAIL-CLOSED: DB query error during active status check -> do NOT proceed to Better Auth
          return new Response(
            JSON.stringify({
              success: false,
              error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Veritabanı erişim hatası nedeniyle kimlik doğrulanamadı.',
              },
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        if (userRow && !userRow.isActive) {
          return new Response(
            JSON.stringify({
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Hesabınız pasif durumdadır.',
              },
            }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }
      }
    }
    return originalHandler(request)
  }

  return authInstance
}

export const auth = createAuth()
