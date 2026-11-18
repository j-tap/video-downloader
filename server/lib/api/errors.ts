import type { Response } from 'express'
import { ERROR_CODES, type ErrorCode } from '../errorCodes'

/**
 * Ошибка API всегда одного вида (договор, «Запросы сервиса»):
 * `{ "error": { code, message, retryable, retryAfterSec } }`.
 *
 * `message` — для журнала и для людей; Todi показывает свой текст по коду.
 */
export interface ApiErrorBody {
  code: ErrorCode
  message: string
  retryable: boolean
  retryAfterSec: number | null
}

export interface MessageContext {
  maxDurationSec?: number
  maxBytes?: number
}

export function apiMessage(code: ErrorCode, context: MessageContext = {}): string {
  switch (code) {
    case 'url_invalid': return 'Это не ссылка на ролик.'
    case 'site_unsupported': return 'Сайт не поддерживается.'
    case 'playlist_not_allowed': return 'Ссылка на подборку, а нужна ссылка на один ролик.'
    case 'no_video': return 'По ссылке нет видео.'
    case 'live_stream': return 'Это прямой эфир.'
    case 'private': return 'Ролик закрыт: нужен вход, подписка или подтверждение возраста.'
    case 'not_found': return 'Ролика нет: удалён или ссылка с ошибкой.'
    case 'geo_blocked': return 'Ролик недоступен в стране сервера.'
    case 'drm': return 'Ролик защищён DRM.'
    case 'too_long':
      return context.maxDurationSec
        ? `Видео длиннее ${Math.round(context.maxDurationSec / 60)} мин.`
        : 'Видео длиннее предела.'
    case 'too_large':
      return context.maxBytes
        ? `Файл больше ${Math.round(context.maxBytes / 1024 / 1024)} МБ.`
        : 'Файл больше предела.'
    case 'source_unreachable': return 'Сайт с роликом не отвечает или не пускает сервер.'
    case 'processing_failed': return 'Ролик скачался, но не обработался.'
    case 'timeout': return 'Задача шла дольше предела и остановлена.'
    case 'queue_full': return 'Очередь ключа заполнена.'
    case 'rate_limited': return 'Слишком много новых задач за час.'
    case 'unauthorized': return 'Нет ключа или ключ неверный.'
    case 'forbidden': return 'Ключ отозван.'
    case 'job_not_found': return 'Задачи нет.'
    case 'file_expired': return 'Файла уже нет.'
    case 'internal': return 'Внутренняя ошибка сервиса.'
    case 'cancelled': return 'Задача отменена.'
    case 'not_ready': return 'Файл ещё не готов.'
    case 'no_thumbnail': return 'У ролика нет обложки.'
    case 'bad_request': return 'Запрос не разобран.'
  }
}

export function errorBody(code: ErrorCode, message = apiMessage(code), retryAfterSec: number | null = null): ApiErrorBody {
  return { code, message, retryable: ERROR_CODES[code].retryable, retryAfterSec }
}

export function sendError(
  res: Response,
  code: ErrorCode,
  options: { status?: number; message?: string; retryAfterSec?: number } = {},
): void {
  const retryAfterSec = options.retryAfterSec ?? null
  if (retryAfterSec !== null) res.setHeader('Retry-After', String(retryAfterSec))
  if (code === 'unauthorized') res.setHeader('WWW-Authenticate', 'Bearer')

  res
    .status(options.status ?? ERROR_CODES[code].status)
    .json({ error: errorBody(code, options.message ?? apiMessage(code), retryAfterSec) })
}
