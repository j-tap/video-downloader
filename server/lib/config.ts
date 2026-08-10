/**
 * Лимиты ресурсов. Сервис публичный, поэтому любой запрос считаем недоверенным:
 * ограничиваем параллелизм, размер, длительность и время жизни файлов.
 */

const GIB = 1024 * 1024 * 1024

export const limits = {
  /** Сколько загрузок может идти одновременно на весь сервер */
  maxConcurrentDownloads: readInt('MAX_CONCURRENT_DOWNLOADS', 3),
  /** Сколько параллельных загрузок разрешено одному клиенту */
  maxConcurrentPerClient: readInt('MAX_CONCURRENT_PER_CLIENT', 1),
  /** Потолок на одну загрузку (в байтах) */
  maxDownloadBytes: readBytes('MAX_DOWNLOAD_SIZE', 4 * GIB),
  /** Потолок на суммарный объём временных файлов */
  maxTotalStorageBytes: readBytes('MAX_TOTAL_STORAGE', 20 * GIB),
  /** Жёсткий таймаут на загрузку */
  downloadTimeoutMs: readInt('DOWNLOAD_TIMEOUT_MINUTES', 30) * 60_000,
  /** Максимальная длительность видео (защита от многочасовых стримов) */
  maxDurationSeconds: readInt('MAX_DURATION_SECONDS', 4 * 3600),
  /** Сколько готовый файл лежит на диске до автоудаления */
  fileTtlMs: readInt('FILE_TTL_MINUTES', 5) * 60_000,
} as const

export function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    const hours = seconds / 3600
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ч`
  }

  if (seconds >= 60) return `${Math.round(seconds / 60)} мин`
  return `${seconds} сек`
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Понимает `4G`, `500M`, `1024K` и просто число байт. */
function readBytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback

  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i)
  if (!match?.[1]) return fallback

  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value) || value <= 0) return fallback

  const multipliers: Record<string, number> = {
    '': 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  }

  return Math.floor(value * (multipliers[(match[2] || '').toLowerCase()] ?? 1))
}
