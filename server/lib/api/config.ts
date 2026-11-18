import path from 'path'
import { limits, readBytes, readInt } from '../config'

/**
 * Настройки API для серверов. Пределы задаёт договор с Todi (раздел
 * «Пределы сервиса на ключ»); переменные нужны, чтобы подкрутить их без
 * пересборки, но нижние границы договора (файл ≥ 60 мин, записи ≥ 24 ч)
 * переменной не опустить.
 */
export interface ApiConfig {
  /** Каталог на томе: база задач и файлы. Переживает пересоздание контейнера. */
  dataDir: string
  /** Сколько готовый файл ждёт, пока его заберут */
  fileTtlMs: number
  /** Сколько хранится запись о завершённой задаче (и действует Idempotency-Key) */
  recordTtlMs: number
  /** Общий потолок сервера (MAX_CONCURRENT_DOWNLOADS): сайт и API делят его */
  serverMaxActive: number
  /** Одновременно в работе у всего API — меньше общего потолка, чтобы сайту оставалось место */
  maxActiveTotal: number
  /** Одновременно в работе у одного ключа */
  maxActivePerKey: number
  /** Ждут в очереди у одного ключа */
  maxQueuedPerKey: number
  /** Новых задач в час на ключ */
  maxJobsPerHour: number
  /** Потолок на все файлы API на томе */
  maxStorageBytes: number
  /** Таймаут одной задачи от начала работы */
  jobTimeoutMs: number
  /** Потолки сервиса; клиент может только ужесточить их */
  maxDurationSec: number
  maxBytes: number
  maxHeight: number
  /** Сколько раз задача переживает перезапуск сервиса посреди работы */
  maxRestarts: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export function loadApiConfig(): ApiConfig {
  // Сайту всегда остаётся хотя бы одна загрузка: при потолке 3 API берёт 2.
  const defaultActiveTotal = Math.max(1, limits.maxConcurrentDownloads - 1)

  return {
    dataDir: path.resolve(process.env.API_DATA_DIR?.trim() || path.join(process.cwd(), 'storage', 'api')),
    fileTtlMs: Math.max(60, readInt('API_FILE_TTL_MINUTES', 60)) * MINUTE,
    recordTtlMs: Math.max(24, readInt('API_RECORD_TTL_HOURS', 24)) * HOUR,
    serverMaxActive: limits.maxConcurrentDownloads,
    maxActiveTotal: Math.min(readInt('API_MAX_ACTIVE', defaultActiveTotal), limits.maxConcurrentDownloads),
    maxActivePerKey: readInt('API_KEY_MAX_ACTIVE', 2),
    maxQueuedPerKey: readInt('API_KEY_MAX_QUEUED', 20),
    maxJobsPerHour: readInt('API_KEY_JOBS_PER_HOUR', 60),
    maxStorageBytes: readBytes('API_MAX_STORAGE', 10 * 1024 ** 3),
    jobTimeoutMs: limits.downloadTimeoutMs,
    maxDurationSec: limits.maxDurationSeconds,
    maxBytes: limits.maxDownloadBytes,
    maxHeight: readInt('API_MAX_HEIGHT', 1080),
    maxRestarts: 2,
  }
}
