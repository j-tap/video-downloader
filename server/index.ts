import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'
import { registerRoutes } from './routes'
import { cleanupOrphanedFiles, getCookiesConfig, verifyYtDlp } from './lib/downloader'
import { clientIdMiddleware } from './lib/security/clientId'
import { limits } from './lib/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const port = process.env.PORT || 3000
const app = express()

// За Traefik реальный IP приходит в X-Forwarded-For — без этого
// rate limit считал бы всех пользователей одним клиентом.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1))
app.disable('x-powered-by')

/**
 * CORS: по умолчанию запрещаем кросс-доменные вызовы — UI живёт на том же origin.
 * CORS_ORIGINS=https://a.com,https://b.com включает точечный allowlist.
 */
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(cors({
  origin: corsOrigins.length > 0 ? corsOrigins : false,
  credentials: corsOrigins.length > 0,
}))

app.use(express.json({ limit: '16kb' }))
app.use(securityHeaders)
app.use(clientIdMiddleware)

// Статические файлы из папки client (должно быть первым)
const clientPath = path.join(__dirname, '../client')
app.use(express.static(clientPath, {
  maxAge: 0, // Отключаем кеш в development
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    // Отключаем кеш для статических файлов в development
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    }
  }
}))

// Регистрируем API маршруты
registerRoutes(app)

// Отдаем index.html для корневого маршрута (в самом конце)
app.get('/', (req, res) => {
  // Отключаем кеш для HTML
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.sendFile(path.join(clientPath, 'index.html'))
})

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  next()
}

const ytDlp = verifyYtDlp()
if (!ytDlp.ok) {
  console.error(`❌ yt-dlp unavailable: ${ytDlp.error}`)
  console.error('Install: pip install "yt-dlp[default]" or set YTDLP_PATH')
  process.exit(1)
}

const orphans = cleanupOrphanedFiles()
if (orphans > 0) {
  console.log(`🧹 Удалено осиротевших временных файлов: ${orphans}`)
}

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`)
  console.log(`yt-dlp ${ytDlp.version}`)
  if (ytDlp.ageDays !== undefined && ytDlp.ageDays > 45) {
    console.warn(
      `⚠️  yt-dlp собран ${ytDlp.ageDays} дней назад — экстракторы могли устареть. `
      + 'Пересоберите образ: make rebuild',
    )
  }
  console.log(`Client path: ${clientPath}`)
  console.log(
    `Limits: ${limits.maxConcurrentDownloads} параллельно, `
    + `${(limits.maxDownloadBytes / 1024 ** 3).toFixed(1)} GB на файл, `
    + `${(limits.maxTotalStorageBytes / 1024 ** 3).toFixed(1)} GB всего, `
    + `таймаут ${limits.downloadTimeoutMs / 60_000} мин`,
  )

  const cookies = getCookiesConfig()
  if (cookies.fromBrowser) {
    console.log(`Cookies: --cookies-from-browser ${cookies.fromBrowser}`)
  } else if (cookies.file) {
    console.log(`Cookies: ${cookies.file}`)
  } else {
    console.warn('Cookies: не настроены (data/cookies.txt или COOKIES_FILE)')
  }

  void reportPotProvider()
})

/**
 * Провайдер PO Token недоступен молча: yt-dlp просто скачает YouTube хуже
 * (403 или единственная дорожка 360p). Проверяем на старте, чтобы это было
 * видно в логах, но загрузки от результата не зависят.
 */
async function reportPotProvider(): Promise<void> {
  const baseUrl = process.env.POT_PROVIDER_BASE_URL?.trim()
  if (!baseUrl) {
    console.warn('PO Token: провайдер не настроен (POT_PROVIDER_BASE_URL)')
    return
  }

  try {
    const response = await fetch(new URL('/ping', baseUrl), {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    console.log(`PO Token: провайдер доступен (${baseUrl})`)
  } catch (error) {
    console.warn(`⚠️  PO Token: провайдер ${baseUrl} недоступен (${(error as Error).message}) — YouTube может отдавать 360p или 403`)
  }
}
