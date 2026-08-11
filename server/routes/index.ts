import type { Express } from 'express'
import { downloadHandler } from './download'
import { statusHandler } from './status'
import { fileHandler } from './file'
import { cancelHandler } from './cancel'
import { createRateLimiter, readRateLimitEnv } from '../lib/security/rateLimit'

/**
 * Запуск загрузки — дорогая операция (yt-dlp + ffmpeg + диск),
 * поэтому лимит на неё заметно жёстче, чем на опрос статуса.
 */
const downloadLimiter = createRateLimiter({
  name: 'download',
  windowMs: readRateLimitEnv('RATE_LIMIT_DOWNLOAD_WINDOW_MINUTES', 10) * 60_000,
  max: readRateLimitEnv('RATE_LIMIT_DOWNLOAD_MAX', 5),
  message: 'Слишком много загрузок с вашего адреса. Попробуйте позже.',
})

const apiLimiter = createRateLimiter({
  name: 'api',
  windowMs: readRateLimitEnv('RATE_LIMIT_API_WINDOW_MINUTES', 1) * 60_000,
  max: readRateLimitEnv('RATE_LIMIT_API_MAX', 240),
  message: 'Слишком много запросов. Попробуйте позже.',
})

export function registerRoutes(app: Express) {
  app.post('/download', downloadLimiter, downloadHandler as any)
  app.post('/cancel/:id', apiLimiter, cancelHandler as any)
  app.get('/status/:id', apiLimiter, statusHandler as any)
  app.get('/file/:id', apiLimiter, fileHandler as any)
}
