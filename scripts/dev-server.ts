import { createServer as createHttpServer } from 'node:http'
import { toNodeHandler } from 'better-auth/node'
import { createServer as createViteServer } from 'vite'
import { auth } from '../server/auth'
import { env } from '../server/env'
import { dispatchNodeApi } from '../server/api/router'

if (env.APP_ENV !== 'development' || env.TURSO_DATABASE_URL !== 'file:./data/development.db' || env.TURSO_AUTH_TOKEN) {
  throw new Error('Yerel sunucu yalnızca APP_ENV=development ve TURSO_DATABASE_URL=file:./data/development.db hedefiyle çalışır.')
}

const authHandler = toNodeHandler(auth)
const httpServer = createHttpServer()
const vite = await createViteServer({
  configFile: './vite.config.ts',
  server: { middlewareMode: true, hmr: { server: httpServer } },
  appType: 'spa',
})
httpServer.on('request', async (req, res) => {
  if ((req.url ?? '').startsWith('/api/auth/')) {
    if (req.url?.includes('/sign-up')) {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Herkese açık kullanıcı kaydı kapatılmıştır.' } }))
      return
    }
    await authHandler(req, res)
    return
  }
  if ((req.url ?? '').startsWith('/api/')) {
    await dispatchNodeApi(req, res)
    return
  }
  vite.middlewares(req, res)
})

const port = Number(process.env.PORT ?? 3000)
httpServer.listen(port, '127.0.0.1', () => {
  console.log(`Yerel BİLSEM geliştirme sunucusu: http://localhost:${port}`)
  console.log('API ve Better Auth yalnızca file:./data/development.db kullanır.')
})

async function shutdown() {
  await vite.close()
  httpServer.close()
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
