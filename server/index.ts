import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'
import { registerRoutes } from './routes'
import { createPageHandler } from './routes/page'
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

const clientPath = path.join(__dirname, '../client')

// index.html отдаём сами и до express.static: статика обслужила бы `/`
// своим index.html в обход обработчика, а он подменяет разметку футера
// в зависимости от того, кто пришёл — краулер или живой посетитель.
const pageHandler = createPageHandler(clientPath)
app.get('/', pageHandler)
app.get('/index.html', pageHandler)

// Остальные статические файлы из папки client
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

const POT_PING_ATTEMPTS = 6
const POT_PING_DELAY_MS = 5000

/**
 * Провайдер PO Token недоступен молча: yt-dlp просто скачает YouTube хуже
 * (403 или единственная дорожка 360p). Проверяем на старте, чтобы это было
 * видно в логах, но загрузки от результата не зависят.
 *
 * Проверяем с повторами: `depends_on` в compose дожидается только запуска
 * контейнера, а не готовности сервиса внутри него, поэтому одиночный пинг
 * сразу после старта почти всегда уходит раньше, чем провайдер начинает
 * слушать, — и в лог падало предупреждение о вполне живом сервисе.
 */
async function reportPotProvider(): Promise<void> {
  const baseUrl = process.env.POT_PROVIDER_BASE_URL?.trim()
  if (!baseUrl) {
    console.warn('PO Token: провайдер не настроен (POT_PROVIDER_BASE_URL)')
    return
  }

  for (let attempt = 1; attempt <= POT_PING_ATTEMPTS; attempt += 1) {
    const failure = await pingPotProvider(baseUrl)

    if (!failure) {
      console.log(`PO Token: провайдер доступен (${baseUrl})`)
      return
    }

    if (attempt === POT_PING_ATTEMPTS) {
      const waited = (POT_PING_ATTEMPTS - 1) * POT_PING_DELAY_MS / 1000
      console.warn(
        `⚠️  PO Token: провайдер ${baseUrl} не ответил за ${waited} с (${failure}) `
        + '— YouTube может отдавать 360p или 403',
      )
      return
    }

    await new Promise((resolve) => setTimeout(resolve, POT_PING_DELAY_MS))
  }
}

/** Возвращает описание ошибки или null, если провайдер ответил. */
async function pingPotProvider(baseUrl: string): Promise<string | null> {
  try {
    const response = await fetch(new URL('/ping', baseUrl), {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok ? null : `HTTP ${response.status}`
  } catch (error) {
    return (error as Error).message
  }
}
