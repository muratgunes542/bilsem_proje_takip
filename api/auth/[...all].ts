import type { IncomingMessage, ServerResponse } from 'node:http'
import { toNodeHandler } from 'better-auth/node'
import { auth } from '../../server/auth.js'

const nodeHandler = toNodeHandler(auth)

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.includes('/sign-up')) {
    res.statusCode = 403
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Herkese açık kullanıcı kaydı kapatılmıştır.' } }))
    return
  }
  return nodeHandler(req, res)
}
