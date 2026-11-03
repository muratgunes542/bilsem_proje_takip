
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { toNodeHandler } from 'better-auth/node'
import { auth } from '../server/auth'
import { env } from '../server/env'
import { dispatchNodeApi } from '../server/api/router'

if (env.APP_ENV !== 'production') {
  throw new Error('Üretim sunucusu yalnızca APP_ENV=production ile çalıştırılabilir.')
}
const authHandler = toNodeHandler(auth)
const distDir = resolve(process.cwd(), 'dist')

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

async function serveFile(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  filePath: string,
) {
  const fileStat = await stat(filePath)

  if (!fileStat.isFile()) return false

  res.statusCode = 200
  res.setHeader(
    'Content-Type',
    mimeTypes[extname(filePath)] ?? 'application/octet-stream',
  )
  res.setHeader('Content-Length', fileStat.size)

  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  createReadStream(filePath).pipe(res)
  return true
}

async function handleRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) {
  const url = req.url ?? '/'
  const pathname = new URL(url, 'http://localhost').pathname

  if (pathname === '/health') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

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

    await authHandler(req, res)
    return
  }

  if (pathname.startsWith('/api/')) {
    await dispatchNodeApi(req, res)
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.end('Method Not Allowed')
    return
  }

  let requestedPath: string

  try {
    requestedPath = decodeURIComponent(pathname)
  } catch {
    res.statusCode = 400
    res.end('Bad Request')
    return
  }

  const filePath = resolve(distDir, `.${requestedPath}`)

  if (filePath !== distDir && !filePath.startsWith(distDir + sep)) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  try {
    if (await serveFile(req, res, filePath)) return

    // React Router gibi istemci tarafı sayfalar için SPA fallback.
    await serveFile(req, res, resolve(distDir, 'index.html'))
  } catch {
    res.statusCode = 404
    res.end('Not Found')
  }
}

const port = Number(process.env.PORT ?? 3000)

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error('Request error:', error)

    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        success: false,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Sunucu hatası oluştu.' },
      }))
    } else {
      res.destroy()
    }
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`BİLSEM Proje Takip sunucusu port ${port} üzerinde çalışıyor.`)
  console.log(`Ortam: ${env.APP_ENV}`)
})

function shutdown() {
  server.close(() => {
    console.log('Sunucu kapatıldı.')
    process.exit(0)
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
