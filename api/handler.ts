import type { IncomingMessage, ServerResponse } from 'node:http'
import { toNodeHandler } from 'better-auth/node'
import { auth } from '../server/auth.js'
import { dispatchNodeApi } from '../server/api/router.js'

const authHandler = toNodeHandler(auth)

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const incomingUrl = new URL(req.url ?? '/', 'http://localhost')
  const forwardedPath = incomingUrl.searchParams.get('__path')

  if (forwardedPath !== null) {
    const normalizedPath = forwardedPath.replace(/^\/+/, '')

    if (
      !normalizedPath ||
      normalizedPath.split('/').some(
        segment => segment === '.' || segment === '..',
      )
    ) {
      res.statusCode = 400
      res.end('Invalid API path')
      return
    }

    const searchParams = new URLSearchParams(incomingUrl.searchParams)
    searchParams.delete('__path')

    req.url = `/api/${normalizedPath}${
      searchParams.size > 0 ? `?${searchParams.toString()}` : ''
    }`
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname

  if (pathname.startsWith('/api/auth/')) {
    if (pathname.includes('/sign-up')) {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Herkese açık kullanıcı kaydı kapatılmıştır.',
        },
      }))
      return
    }

    return authHandler(req, res)
  }

  await dispatchNodeApi(req, res)
}
