import crypto from 'crypto'
import type { ErrorCode } from '../errorCodes'
import type { JobPatch } from './store'

/**
 * Проверка до скачивания по метаданным yt-dlp (`--dump-single-json`).
 * Договор требует отказать сразу, а не после получаса работы: длинный ролик,
 * огромный файл, эфир, подборка и пост без видео видны ещё до загрузки.
 */

export interface ProbeFormat {
  vcodec?: string | null
  acodec?: string | null
  height?: number | null
  filesize?: number | null
  filesize_approx?: number | null
}

export interface ProbeInfo extends ProbeFormat {
  _type?: string
  id?: string
  title?: string
  uploader?: string | null
  channel?: string | null
  creator?: string | null
  uploader_id?: string | null
  duration?: number | null
  is_live?: boolean | null
  live_status?: string | null
  extractor?: string
  extractor_key?: string
  ie_key?: string
  webpage_url?: string
  url?: string
  entries?: Array<ProbeInfo | null>
  requested_formats?: ProbeFormat[]
  formats?: ProbeFormat[]
}

export interface ProbeLimits {
  maxDurationSec: number
  maxBytes: number
}

export interface ProbeContext {
  /** Исходная ссылка — по ней видна площадка и номер серии kino.pub */
  sourceUrl: string
  kinoPub: boolean
  /** Элемент подборки, указанный в ссылке (слайд Instagram, история, серия kino.pub) */
  playlistItemIndex: number | null
  entryId: string | null
}

export type ProbeVerdict =
  | { ok: true; meta: JobPatch }
  | { ok: false; code: ErrorCode; detail: string }

const LIVE_STATUSES = new Set(['is_live', 'is_upcoming', 'post_live'])

export function evaluateProbe(root: ProbeInfo, limits: ProbeLimits, context: ProbeContext): ProbeVerdict {
  const picked = pickEntry(root, context)
  if (!picked.ok) return picked
  const info = picked.info

  if (info.is_live === true || (info.live_status && LIVE_STATUSES.has(info.live_status))) {
    return { ok: false, code: 'live_stream', detail: `live_status=${info.live_status ?? 'is_live'}` }
  }

  if (typeof info.duration === 'number' && info.duration > limits.maxDurationSec) {
    return { ok: false, code: 'too_long', detail: `duration ${info.duration}s > ${limits.maxDurationSec}s` }
  }

  const bytes = estimateBytes(info)
  if (bytes !== null && bytes > limits.maxBytes) {
    return { ok: false, code: 'too_large', detail: `estimated ${bytes} bytes > ${limits.maxBytes}` }
  }

  if (hasNoVideo(info)) {
    return { ok: false, code: 'no_video', detail: 'only audio or image formats' }
  }

  return { ok: true, meta: describe(info, root, context) }
}

function pickEntry(root: ProbeInfo, context: ProbeContext): { ok: true; info: ProbeInfo } | { ok: false; code: ErrorCode; detail: string } {
  if (root._type !== 'playlist' && root._type !== 'multi_video') return { ok: true, info: root }

  const entries = (root.entries ?? []).filter((entry): entry is ProbeInfo => Boolean(entry))

  if (context.entryId) {
    const found = entries.find((entry) => entry.id === context.entryId)
    return found
      ? { ok: true, info: found }
      : { ok: false, code: 'not_found', detail: `entry ${context.entryId} not in playlist` }
  }

  if (context.playlistItemIndex) {
    const found = entries[context.playlistItemIndex - 1]
    return found
      ? { ok: true, info: found }
      : { ok: false, code: 'not_found', detail: `item ${context.playlistItemIndex} of ${entries.length}` }
  }

  // Страница kino.pub — это фильм и его трейлеры; нужный элемент загрузчик
  // выбирает сам (resolveDownloadTarget), подборкой это не считается.
  if (context.kinoPub) return { ok: true, info: { ...root, _type: 'video', duration: null } }

  if (entries.length === 1 && entries[0]) return { ok: true, info: entries[0] }

  return { ok: false, code: 'playlist_not_allowed', detail: `playlist of ${entries.length}` }
}

/** Размер выбранных дорожек, если источник его сообщил. Неизвестный размер — не повод отказать. */
export function estimateBytes(info: ProbeInfo): number | null {
  const parts: ProbeFormat[] = info.requested_formats?.length ? info.requested_formats : [info]
  let total = 0
  let known = false

  for (const part of parts) {
    const size = part.filesize ?? part.filesize_approx
    if (typeof size === 'number' && size > 0) {
      total += size
      known = true
    }
  }

  return known ? total : null
}

function hasNoVideo(info: ProbeInfo): boolean {
  const selected = info.requested_formats?.length ? info.requested_formats : [info]
  // Поле vcodec у многих источников просто не заполнено — это не «нет видео».
  // Отказываем только когда источник прямо сказал: видеодорожек нет.
  if (selected.every((format) => format.vcodec === 'none')) return true

  const formats = info.formats ?? []
  return formats.length > 0 && formats.every((format) => format.vcodec === 'none')
}

/**
 * Метаданные для ответа. `extractor:sourceId` — ключ Todi для поиска повторов,
 * поэтому он обязан быть устойчивым: у kino.pub ролик приходит манифестом
 * с CDN, где id вроде `master` одинаков у всех фильмов, — берём id со страницы.
 */
function describe(info: ProbeInfo, root: ProbeInfo, context: ProbeContext): JobPatch {
  const extractorRaw = info.extractor ?? info.extractor_key ?? info.ie_key ?? root.extractor ?? root.extractor_key ?? 'generic'
  let extractor = extractorRaw.toLowerCase()
  let sourceId = info.id ?? root.id ?? null
  let webpageUrl = info.webpage_url ?? root.webpage_url ?? context.sourceUrl

  const kinoPubId = context.kinoPub ? kinoPubSourceId(context.sourceUrl) : null
  if (kinoPubId) {
    extractor = 'kinopub'
    sourceId = kinoPubId
    webpageUrl = context.sourceUrl
  } else if (extractor === 'generic') {
    sourceId = stableUrlId(webpageUrl)
  }

  const duration = typeof info.duration === 'number' ? Math.round(info.duration) : null

  return {
    title: trim(info.title ?? root.title, 300),
    uploader: trim(info.uploader ?? info.channel ?? info.creator ?? info.uploader_id ?? root.uploader ?? null, 200),
    durationSec: duration,
    extractor,
    sourceId: sourceId ? String(sourceId).slice(0, 200) : null,
    webpageUrl: webpageUrl?.slice(0, 2048) ?? null,
  }
}

/** `kino.pub/item/view/123/s1e2` → `123:s1e2`; без серии — `123`. */
export function kinoPubSourceId(url: string): string | null {
  const item = url.match(/\/item\/view\/(\d+)/)?.[1]
  if (!item) return null
  const episode = url.match(/\/s(\d+)e(\d+)/i)
  return episode ? `${item}:s${Number(episode[1])}e${Number(episode[2])}` : item
}

function stableUrlId(url: string): string {
  let normalized = url
  try {
    const parsed = new URL(url)
    normalized = `${parsed.hostname}${parsed.pathname}`
  } catch {
    // оставляем как есть
  }
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function trim(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, max) : null
}
