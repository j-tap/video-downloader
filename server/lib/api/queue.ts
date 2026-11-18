import type { ApiConfig } from './config'
import type { JobFiles } from './files'
import { RUNNING, type JobPatch, type JobRecord, type JobStore } from './store'
import { setActiveApiJobs } from './activity'
import { logEvent, outputTail, type LogLevel } from './log'
import { apiMessage } from './errors'
import { isErrorCode, type ErrorCode } from '../errorCodes'

/**
 * Очередь задач API. У сайта при занятости сразу 503 — человек нажмёт ещё раз;
 * серверу нужна очередь: задача ждёт, пока освободится место.
 *
 * Место ограничено трижды: у ключа (2 в работе, договор), у всего API
 * (меньше общего потолка, чтобы сайту оставалось место) и у сервера целиком
 * (сайт и API делят MAX_CONCURRENT_DOWNLOADS).
 */

export interface ExecHooks {
  setStatus(status: 'downloading' | 'processing'): void
  setProgress(progress: number): void
  setMeta(patch: JobPatch): void
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void
}

export interface ReadyFile {
  sizeBytes: number
  sha256: string
  width: number
  height: number
  durationSec: number
  hasThumbnail: boolean
}

export type ExecResult =
  | { ok: true; file: ReadyFile }
  | { ok: false; code: ErrorCode; message?: string; output?: string; exitCode?: number | null }

export type Executor = (job: JobRecord, hooks: ExecHooks, signal: AbortSignal) => Promise<ExecResult>

export interface QueueDeps {
  store: JobStore
  files: JobFiles
  config: ApiConfig
  executor: Executor
  /** Сколько загрузок сайта идёт сейчас: потолок сервера общий */
  siteActive: () => number
  now?: () => number
}

type AbortReason = 'cancelled' | 'timeout' | 'shutdown'

interface Running {
  controller: AbortController
  keyName: string
  timer: ReturnType<typeof setTimeout>
  done: Promise<void>
}

const PUMP_INTERVAL_MS = 2000
const SWEEP_INTERVAL_MS = 60_000

export class JobQueue {
  private readonly running = new Map<string, Running>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private storageWarned = false
  private readonly now: () => number

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Запуск: подобрать брошенное перезапуском, затем опрос и сборщик по таймеру. */
  start(): void {
    this.recover()
    this.sweep()
    this.pump()

    // Опрос по таймеру нужен, потому что место освобождает и сайт,
    // а он об этом очереди не сообщает.
    const pumpTimer = setInterval(() => this.pump(), PUMP_INTERVAL_MS)
    const sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    pumpTimer.unref?.()
    sweepTimer.unref?.()
    this.timers = [pumpTimer, sweepTimer]
  }

  /** Остановить таймеры и текущие задачи (тесты, завершение процесса). */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    const pending = [...this.running.values()].map((run) => {
      run.controller.abort('shutdown' satisfies AbortReason)
      return run.done
    })
    await Promise.all(pending)
  }

  activeCount(): number {
    return this.running.size
  }

  queuedCount(): number {
    return this.deps.store.countByStatus(['queued'])
  }

  /**
   * Перезапуск посреди работы процесс не переживает, а задачу — да:
   * она возвращается в очередь и начинается заново. Задача, которая уже
   * дважды «пережила» перезапуск, скорее всего сама его и вызывает, — её
   * останавливаем, чтобы не уронить сервис по кругу.
   */
  recover(): void {
    const { store, files, config } = this.deps

    for (const job of store.listByStatus(RUNNING)) {
      if (this.running.has(job.id)) continue
      files.remove(job.id)

      if (job.restarts >= config.maxRestarts) {
        this.finishFailed(job, 'internal', `Задача прервана перезапуском сервиса ${job.restarts + 1} раз.`)
        continue
      }

      store.update(job.id, { status: 'queued', progress: 0, startedAt: null, restarts: job.restarts + 1 })
      this.log('warn', 'job.requeued', job, { restarts: job.restarts + 1 })
    }
  }

  /** Поставить в работу всё, что помещается в пределы. */
  pump(): void {
    const { store, config, files } = this.deps
    const queued = store.listByStatus(['queued'])
    if (queued.length === 0) return

    const perKey = new Map<string, number>()
    for (const run of this.running.values()) {
      perKey.set(run.keyName, (perKey.get(run.keyName) ?? 0) + 1)
    }

    let storageUsed: number | null = null

    for (const job of queued) {
      if (this.running.size >= config.maxActiveTotal) break
      if (this.running.size + this.deps.siteActive() >= config.serverMaxActive) break
      if ((perKey.get(job.keyName) ?? 0) >= config.maxActivePerKey) continue

      // Готовые файлы ждут, пока их заберут. Если тома не хватает, задача
      // ждёт в очереди, а не падает: место освободится само через TTL.
      storageUsed ??= files.usedBytes()
      const reserved = [...this.running.keys()].reduce((sum, id) => sum + (store.get(id)?.maxBytes ?? 0), 0)
      if (storageUsed + reserved + job.maxBytes > config.maxStorageBytes) {
        if (!this.storageWarned) {
          this.storageWarned = true
          logEvent('warn', 'storage.full', { usedBytes: storageUsed, maxBytes: config.maxStorageBytes })
        }
        break
      }
      this.storageWarned = false

      perKey.set(job.keyName, (perKey.get(job.keyName) ?? 0) + 1)
      this.launch(job)
    }
  }

  /**
   * DELETE /jobs/:id. Идущую задачу останавливает, готовую стирает с диска,
   * завершённую оставляет как есть: удалять удалённое — не ошибка.
   */
  cancelOrDelete(job: JobRecord, requestId?: string): void {
    const { store, files } = this.deps
    const now = this.now()

    if (job.status === 'queued' || RUNNING.includes(job.status)) {
      // Отметку ставим сразу: опрос после DELETE должен видеть отмену,
      // а не «downloading» до тех пор, пока yt-dlp не выйдет.
      store.update(job.id, {
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: apiMessage('cancelled'),
        finishedAt: now,
      })
      const run = this.running.get(job.id)
      if (run) run.controller.abort('cancelled' satisfies AbortReason)
      else this.purgeFiles(job.id)
      this.log('info', 'job.cancelled', { ...job, requestId: requestId ?? job.requestId }, { elapsedMs: now - job.createdAt })
      return
    }

    if (!job.filesPurged) {
      this.purgeFiles(job.id)
      store.update(job.id, { expiresAt: job.status === 'ready' ? Math.min(job.expiresAt ?? now, now) : job.expiresAt })
      if (job.status === 'ready') {
        this.log('info', 'job.deleted', { ...job, requestId: requestId ?? job.requestId })
      }
    }
  }

  /**
   * Сборщик: истёкшие файлы, каталоги без задачи (падение посреди записи,
   * ручная правка базы) и записи старше срока хранения.
   */
  sweep(): void {
    const { store, files, config } = this.deps
    const now = this.now()
    const keep = new Set<string>()

    for (const job of store.listWithFiles()) {
      if (job.status === 'ready' && job.expiresAt !== null && job.expiresAt <= now) {
        this.purgeFiles(job.id)
        logEvent('info', 'job.expired', { requestId: job.requestId, jobId: job.id, key: job.keyName })
        continue
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        if (!this.running.has(job.id)) this.purgeFiles(job.id)
        continue
      }

      keep.add(job.id)
    }

    for (const id of this.running.keys()) keep.add(id)

    let orphans = 0
    for (const id of files.listIds()) {
      if (keep.has(id)) continue
      files.remove(id)
      orphans += 1
    }
    if (orphans > 0) logEvent('info', 'files.orphans_removed', { count: orphans })

    store.purgeFinishedBefore(now - config.recordTtlMs)
  }

  private launch(job: JobRecord): void {
    const { store, config, executor } = this.deps
    const controller = new AbortController()
    const startedAt = this.now()

    store.update(job.id, { status: 'downloading', startedAt, progress: 0 })
    const current: JobRecord = { ...job, status: 'downloading', startedAt }
    this.log('info', 'job.started', current, { waitedMs: startedAt - job.createdAt })

    const timer = setTimeout(() => controller.abort('timeout' satisfies AbortReason), config.jobTimeoutMs)
    timer.unref?.()

    let lastProgress = 0
    const hooks: ExecHooks = {
      setStatus: (status) => {
        if (controller.signal.aborted) return
        store.update(job.id, { status })
      },
      setProgress: (progress) => {
        if (controller.signal.aborted) return
        // Прогресс не откатывается: у ролика из двух дорожек yt-dlp считает
        // каждую от нуля, а Todi рисует полосу, которая не должна прыгать назад.
        const next = Math.min(99, Math.max(lastProgress, Math.floor(progress)))
        if (next === lastProgress) return
        lastProgress = next
        store.update(job.id, { progress: next })
      },
      setMeta: (patch) => {
        if (controller.signal.aborted) return
        store.update(job.id, patch)
      },
      log: (level, event, fields = {}) => this.log(level, event, current, fields),
    }

    const done = (async () => {
      let result: ExecResult
      try {
        result = await executor(current, hooks, controller.signal)
      } catch (error) {
        result = { ok: false, code: 'internal', message: (error as Error)?.message, output: String((error as Error)?.stack || error) }
      }
      clearTimeout(timer)
      this.running.delete(job.id)
      setActiveApiJobs(this.running.size)
      this.settle(job.id, result, controller.signal)
      this.pump()
    })()

    this.running.set(job.id, { controller, keyName: job.keyName, timer, done })
    setActiveApiJobs(this.running.size)
  }

  private settle(id: string, result: ExecResult, signal: AbortSignal): void {
    const { store, config } = this.deps
    const job = store.get(id)
    if (!job) return
    const now = this.now()

    if (signal.aborted) {
      const reason = signal.reason as AbortReason
      if (reason === 'timeout') {
        this.finishFailed(job, 'timeout', apiMessage('timeout'), result.ok ? undefined : result.output)
        return
      }
      // Отмену уже записал cancelOrDelete; остановка процесса — не ошибка
      // задачи: после перезапуска recover() вернёт её в очередь.
      if (reason === 'shutdown') return
      this.purgeFiles(id)
      return
    }

    if (job.status === 'cancelled') {
      this.purgeFiles(id)
      return
    }

    if (result.ok) {
      store.update(id, {
        status: 'ready',
        progress: 100,
        ...result.file,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        expiresAt: now + config.fileTtlMs,
      })
      this.log('info', 'job.ready', job, {
        elapsedMs: now - (job.startedAt ?? job.createdAt),
        durationSec: result.file.durationSec,
        sizeBytes: result.file.sizeBytes,
      })
      return
    }

    // Код, которого нет в договоре, наружу не уходит: Todi прочла бы его
    // как internal, а мы потеряли бы, что случилось. Пишем как internal сами.
    const code: ErrorCode = isErrorCode(result.code) ? result.code : 'internal'
    this.finishFailed(job, code, result.message ?? apiMessage(code, job), result.output, result.exitCode)
  }

  private finishFailed(job: JobRecord, code: ErrorCode, message: string, output?: string, exitCode?: number | null): void {
    const now = this.now()
    this.deps.store.update(job.id, {
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      finishedAt: now,
      expiresAt: null,
    })
    this.purgeFiles(job.id)
    this.log('error', 'job.failed', job, {
      code,
      elapsedMs: now - (job.startedAt ?? job.createdAt),
      exitCode: exitCode ?? undefined,
      ytDlpTail: output ? outputTail(output) : undefined,
    })
  }

  private purgeFiles(id: string): void {
    this.deps.files.remove(id)
    this.deps.store.update(id, { filesPurged: true })
  }

  private log(level: LogLevel, event: string, job: Pick<JobRecord, 'id' | 'requestId' | 'keyName' | 'host'>, fields: Record<string, unknown> = {}): void {
    logEvent(level, event, { requestId: job.requestId, jobId: job.id, key: job.keyName, host: job.host, ...fields })
  }
}
