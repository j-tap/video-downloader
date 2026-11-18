import crypto from 'crypto'
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express'
import fs from 'fs'
import type { ApiConfig } from '../lib/api/config'
import { isCollectionUrl } from '../lib/api/collections'
import { errorBody, sendError } from '../lib/api/errors'
import type { JobFiles } from '../lib/api/files'
import { authenticate, type KeyRing } from '../lib/api/keys'
import { logEvent } from '../lib/api/log'
import type { JobQueue } from '../lib/api/queue'
import type { JobRecord, JobStore } from '../lib/api/store'
import { isErrorCode } from '../lib/errorCodes'
import { assertPublicUrl, checkUrlSync, type UrlGuardResult } from '../lib/security/urlGuard'

/**
 * API для серверов (`/api/v1`), первый клиент — Todi. Договор: docs/video-links.md
 * в репозитории childs-games. Запросы с ключом не проходят защиты для людей —
 * куку `vd_client`, предел по IP, «одна загрузка на IP», — вместо них пределы
 * на ключ. CORS здесь не включается: зовёт сервер, а не браузер.
 */

export interface ApiV1Deps {
  store: JobStore
  queue: JobQueue
  files: JobFiles
  config: ApiConfig
  keyRing: KeyRing
  ytDlpVersion: string | null
  /** Сколько загрузок сайта идёт сейчас — для /health */
  siteActive: () => number
  now?: () => number
  /** Проверка ссылки по сети (DNS, редиректы); тесты подменяют её, чтобы не ходить в сеть */
  checkUrl?: (url: string) => Promise<UrlGuardResult>
}

interface Locals {
  requestId: string
  keyName: string
}

const HOUR_MS = 60 * 60_000
const IDEMPOTENCY_TTL_MS = 24 * HOUR_MS
const QUEUE_FULL_RETRY_SEC = 60
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createApiV1Router(deps: ApiV1Deps): Router {
  const { store, queue, files, config, keyRing } = deps
  const now = deps.now ?? Date.now
  const checkUrl = deps.checkUrl ?? ((url: string) => assertPublicUrl(url, { checkRedirects: true }))
  const router = express.Router()

  router.use(requestIdMiddleware)
  router.use(authMiddleware)
  router.use(express.json({ limit: '16kb' }))

  router.post('/jobs', handle(async (req, res) => {
    const { keyName, requestId } = locals(res)
    const createdAt = now()

    const idempotencyKey = req.get('Idempotency-Key')?.trim() || null
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return sendError(res, 'bad_request', { message: 'Idempotency-Key: 1–255 печатных ASCII-символов.' })
    }

    // Повтор после обрыва сети: та же задача, а не вторая загрузка.
    // Раньше всех проверок — ответ на повтор не должен зависеть от пределов.
    const replay = idempotencyKey ? store.findByIdempotencyKey(keyName, idempotencyKey, createdAt - IDEMPOTENCY_TTL_MS) : null
    if (replay) return acceptReplay(res, replay, requestId)

    const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {}
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) return sendError(res, 'url_invalid', { message: 'Нет ссылки в поле url.' })

    const requested = {
      maxDurationSec: readLimit(body.maxDurationSec),
      maxBytes: readLimit(body.maxBytes),
      maxHeight: readLimit(body.maxHeight),
    }
    const badLimit = Object.entries(requested).find(([, value]) => value === 'invalid')
    if (badLimit) {
      return sendError(res, 'bad_request', { message: `${badLimit[0]}: нужно целое число больше нуля.` })
    }

    const syncCheck = checkUrlSync(url)
    if (!syncCheck.ok) return rejectUrl(res, syncCheck, requestId, keyName, url)
    if (isCollectionUrl(url)) {
      return sendError(res, 'playlist_not_allowed')
    }

    // Предел «новых в час» считается по базе: переживает перезапуск сервиса.
    const recent = store.creationTimesSince(keyName, createdAt - HOUR_MS)
    if (recent.length >= config.maxJobsPerHour) {
      const oldestCounted = recent[recent.length - config.maxJobsPerHour] ?? createdAt
      const retryAfterSec = Math.max(1, Math.ceil((oldestCounted + HOUR_MS - createdAt) / 1000))
      logEvent('warn', 'job.rejected', { requestId, key: keyName, code: 'rate_limited' })
      return sendError(res, 'rate_limited', { retryAfterSec })
    }

    if (store.countByKey(keyName, ['queued']) >= config.maxQueuedPerKey) {
      logEvent('warn', 'job.rejected', { requestId, key: keyName, code: 'queue_full' })
      return sendError(res, 'queue_full', { retryAfterSec: QUEUE_FULL_RETRY_SEC })
    }

    // Та же проверка, что у сайта: DNS и цепочка редиректов до запуска yt-dlp.
    const guard = await checkUrl(url)
    if (!guard.ok) return rejectUrl(res, guard, requestId, keyName, url)

    // Пока шла сетевая проверка, тот же Idempotency-Key мог прийти второй раз.
    if (idempotencyKey) {
      const raced = store.findByIdempotencyKey(keyName, idempotencyKey, createdAt - IDEMPOTENCY_TTL_MS)
      if (raced) return acceptReplay(res, raced, requestId)
      store.releaseIdempotencyKey(keyName, idempotencyKey, createdAt - IDEMPOTENCY_TTL_MS)
    }

    const job = newJob({
      keyName,
      requestId,
      idempotencyKey,
      url,
      createdAt,
      maxDurationSec: Math.min(config.maxDurationSec, numberOr(requested.maxDurationSec, config.maxDurationSec)),
      maxBytes: Math.min(config.maxBytes, numberOr(requested.maxBytes, config.maxBytes)),
      maxHeight: Math.min(config.maxHeight, numberOr(requested.maxHeight, config.maxHeight)),
    })
    store.insert(job)

    logEvent('info', 'job.created', {
      requestId,
      jobId: job.id,
      key: keyName,
      host: job.host,
      maxDurationSec: job.maxDurationSec,
      maxBytes: job.maxBytes,
      maxHeight: job.maxHeight,
    })

    // Ответ — как в договоре: принято и стоит в очереди. В работу задача
    // уходит сразу следом, если есть место.
    res.setHeader('Location', `/api/v1/jobs/${job.id}`)
    res.status(202).json({ id: job.id, status: 'queued' })
    queue.pump()
  }))

  router.get('/jobs/:id', handle((req, res) => {
    const job = findJob(req, res)
    if (!job) return sendError(res, 'job_not_found')
    return res.json(jobView(job))
  }))

  router.get('/jobs/:id/file', handle((req, res, next) => {
    const job = findJob(req, res)
    if (!job) return sendError(res, 'job_not_found')
    if (job.status !== 'ready') return sendError(res, 'not_ready')

    const file = files.videoPath(job.id)
    if (isExpired(job) || !fs.existsSync(file)) return sendError(res, 'file_expired')

    const { requestId, keyName } = locals(res)
    const startedAt = now()

    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('ETag', `"${job.sha256}"`)
    res.setHeader('X-Content-SHA256', job.sha256 ?? '')
    res.setHeader('Cache-Control', 'private, no-transform')
    res.setHeader('Content-Disposition', `attachment; filename="${job.id}.mp4"`)

    res.on('finish', () => {
      logEvent('info', 'file.served', {
        requestId,
        jobId: job.id,
        key: keyName,
        host: job.host,
        status: res.statusCode,
        range: req.get('Range') ?? null,
        contentRange: res.getHeader('Content-Range') ?? null,
        elapsedMs: now() - startedAt,
      })
    })

    // send сам отвечает на Range (206), If-Range (по нашему ETag) и HEAD.
    res.sendFile(file, { acceptRanges: true, cacheControl: false, etag: false, lastModified: true, dotfiles: 'deny' }, (error) => {
      if (!error) return
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNABORTED' || code === 'EPIPE' || res.headersSent) return
      next(error)
    })
  }))

  router.get('/jobs/:id/thumbnail', handle((req, res, next) => {
    const job = findJob(req, res)
    if (!job) return sendError(res, 'job_not_found')
    if (job.status !== 'ready') return sendError(res, 'not_ready')
    if (isExpired(job)) return sendError(res, 'file_expired')

    const file = files.thumbnailPath(job.id)
    if (!job.hasThumbnail || !fs.existsSync(file)) return sendError(res, 'no_thumbnail')

    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, no-transform')
    res.sendFile(file, { cacheControl: false, dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) next(error)
    })
  }))

  router.delete('/jobs/:id', handle((req, res) => {
    // Удалять удалённое — не ошибка, поэтому и неизвестный id получает 204.
    // Чужую задачу при этом не трогаем: её владелец — другой ключ.
    const job = findJob(req, res)
    if (job) queue.cancelOrDelete(job, locals(res).requestId)
    return res.status(204).end()
  }))

  router.get('/health', handle((_req, res) => {
    const apiActive = queue.activeCount()
    res.json({
      ok: Boolean(deps.ytDlpVersion),
      ytDlp: deps.ytDlpVersion,
      active: apiActive + deps.siteActive(),
      queued: queue.queuedCount(),
      maxActive: config.serverMaxActive,
    })
  }))

  router.use((_req, res) => sendError(res, 'bad_request', { status: 404, message: 'Нет такого адреса в API.' }))

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      return sendError(res, 'bad_request', { status: status === 413 ? 413 : 400, message: 'Тело запроса — JSON до 16 КБ.' })
    }

    logEvent('error', 'request.failed', {
      requestId: res.locals.requestId,
      key: res.locals.keyName,
      code: 'internal',
      detail: String((error as Error)?.message || error).slice(0, 500),
    })
    if (res.headersSent) return
    return sendError(res, 'internal')
  })

  function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
    const incoming = req.get('X-Request-Id')?.trim()
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : `vd-${crypto.randomUUID()}`
    res.locals.requestId = requestId
    res.setHeader('X-Request-Id', requestId)
    next()
  }

  function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const result = authenticate(req.get('Authorization'), keyRing)
    if (result.ok) {
      res.locals.keyName = result.name
      return next()
    }

    logEvent('warn', 'auth.denied', {
      requestId: res.locals.requestId,
      key: result.name,
      code: result.code,
      ip: req.ip,
      path: req.path,
    })
    return sendError(res, result.code)
  }

  function findJob(req: Request, res: Response): JobRecord | null {
    const id = String(req.params.id ?? '')
    if (!JOB_ID.test(id)) return null
    return store.getForKey(id, locals(res).keyName)
  }

  function isExpired(job: JobRecord): boolean {
    return job.filesPurged || (job.expiresAt !== null && job.expiresAt <= now())
  }

  function jobView(job: JobRecord) {
    const ready = job.status === 'ready'
    return {
      id: job.id,
      status: job.status,
      progress: Math.round(job.progress),
      title: job.title,
      uploader: job.uploader,
      durationSec: job.durationSec,
      width: job.width,
      height: job.height,
      sizeBytes: job.sizeBytes,
      sha256: job.sha256,
      extractor: job.extractor,
      sourceId: job.sourceId,
      webpageUrl: job.webpageUrl,
      hasThumbnail: ready ? job.hasThumbnail : null,
      expiresAt: job.expiresAt !== null ? new Date(job.expiresAt).toISOString() : null,
      error: job.errorCode
        ? errorBody(isErrorCode(job.errorCode) ? job.errorCode : 'internal', job.errorMessage ?? undefined)
        : null,
    }
  }

  function acceptReplay(res: Response, job: JobRecord, requestId: string) {
    logEvent('info', 'job.replayed', { requestId, jobId: job.id, key: job.keyName, host: job.host })
    res.setHeader('Location', `/api/v1/jobs/${job.id}`)
    return res.status(202).json({ id: job.id, status: job.status })
  }

  function rejectUrl(res: Response, guard: UrlGuardResult, requestId: string, keyName: string, url: string) {
    const code = guard.code ?? 'url_invalid'
    logEvent('info', 'job.rejected', { requestId, key: keyName, host: hostOf(url), code, detail: guard.detail })
    return sendError(res, code)
  }

  return router
}

/** Обработчик может вернуть ответ или промис — Express 5 ждёт void. Ошибки промиса уходят в next. */
function handle(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next)
      if (result instanceof Promise) result.catch(next)
    } catch (error) {
      next(error)
    }
  }
}

function locals(res: Response): Locals {
  return res.locals as unknown as Locals
}

function readLimit(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'invalid'
  return Math.floor(value)
}

function numberOr(value: number | undefined | 'invalid', fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function newJob(input: {
  keyName: string
  requestId: string
  idempotencyKey: string | null
  url: string
  createdAt: number
  maxDurationSec: number
  maxBytes: number
  maxHeight: number
}): JobRecord {
  return {
    id: crypto.randomUUID(),
    keyName: input.keyName,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    url: input.url,
    host: hostOf(input.url) ?? '',
    maxDurationSec: input.maxDurationSec,
    maxBytes: input.maxBytes,
    maxHeight: input.maxHeight,
    status: 'queued',
    progress: 0,
    title: null,
    uploader: null,
    durationSec: null,
    width: null,
    height: null,
    sizeBytes: null,
    sha256: null,
    extractor: null,
    sourceId: null,
    webpageUrl: null,
    hasThumbnail: false,
    errorCode: null,
    errorMessage: null,
    restarts: 0,
    createdAt: input.createdAt,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    filesPurged: false,
  }
}
