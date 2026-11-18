import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { JobFiles } from './files'
import { setLogSink } from './log'
import { JobQueue, type Executor } from './queue'
import { JobStore, type JobRecord } from './store'
import { controllableExecutor, testConfig } from './testing'
import type { ApiConfig } from './config'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup(overrides: Partial<ApiConfig> = {}, executor?: Executor, file = ':memory:') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-queue-test-'))
  const store = new JobStore(file === ':memory:' ? file : path.join(dataDir, file))
  const files = new JobFiles(dataDir)
  const config = testConfig(dataDir, overrides)
  const control = controllableExecutor()
  const logs: Array<Record<string, unknown>> = []
  const previous = setLogSink((line) => logs.push(JSON.parse(line)))
  const queue = new JobQueue({ store, files, config, executor: executor ?? control.executor, siteActive: () => 0 })

  cleanups.push(() => {
    void queue.stop()
    setLogSink(previous)
    store.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  return { store, files, config, control, queue, logs, dataDir }
}

let counter = 0
function job(overrides: Partial<JobRecord> = {}): JobRecord {
  counter += 1
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    keyName: 'todi',
    idempotencyKey: null,
    requestId: `todi-video-${counter}`,
    url: 'https://youtu.be/dQw4w9WgXcQ',
    host: 'youtu.be',
    maxDurationSec: 1800,
    maxBytes: 524288000,
    maxHeight: 720,
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
    createdAt: Date.now() - 1000,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    filesPurged: false,
    ...overrides,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('перезапуск сервиса', () => {
  test('задачи, прерванные посреди работы, возвращаются в очередь и стартуют заново', () => {
    const { store, files, queue } = setup()
    const interrupted = job({ status: 'downloading', startedAt: Date.now() - 500 })
    store.insert(interrupted)
    fs.mkdirSync(files.dirFor(interrupted.id), { recursive: true })
    fs.writeFileSync(path.join(files.dirFor(interrupted.id), 'source.mp4.part'), 'partial')

    queue.recover()

    const recovered = store.get(interrupted.id)!
    expect(recovered.status).toBe('queued')
    expect(recovered.restarts).toBe(1)
    expect(fs.existsSync(files.dirFor(interrupted.id))).toBe(false)
  })

  test('задача, которую перезапуск прервал уже дважды, останавливается как internal', () => {
    const { store, queue, logs } = setup()
    const poison = job({ status: 'processing', restarts: 2 })
    store.insert(poison)

    queue.recover()

    const failed = store.get(poison.id)!
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('internal')
    expect(logs.find((line) => line.event === 'job.failed')).toMatchObject({ jobId: poison.id, requestId: poison.requestId })
  })

  test('записи переживают закрытие базы: после перезапуска задача на месте', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-store-test-'))
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    const file = path.join(dataDir, 'jobs.sqlite')

    const first = new JobStore(file)
    const ready = job({ status: 'ready', sha256: 'abc', expiresAt: Date.now() + 3600_000 })
    first.insert(ready)
    first.close()

    const second = new JobStore(file)
    expect(second.get(ready.id)).toEqual(ready)
    second.close()
  })
})

describe('таймаут задачи', () => {
  test('дольше предела — failed / timeout, процесс получает отмену', async () => {
    const { store, queue, control } = setup({ jobTimeoutMs: 30 })
    const slow = job()
    store.insert(slow)

    queue.pump()
    const run = control.runs.get(slow.id)!
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(run.signal.aborted).toBe(true)
    const failed = store.get(slow.id)!
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('timeout')
  })
})

describe('исполнитель упал с исключением', () => {
  test('задача — internal, очередь живёт дальше', async () => {
    const { store, queue } = setup({}, async () => { throw new Error('boom') })
    const broken = job()
    store.insert(broken)

    queue.pump()
    await settle()

    expect(store.get(broken.id)!.status).toBe('failed')
    expect(store.get(broken.id)!.errorCode).toBe('internal')
    expect(queue.activeCount()).toBe(0)
  })
})

describe('сборщик', () => {
  test('стирает истёкшие файлы, сирот без задачи и старые записи', () => {
    const { store, files, queue, config } = setup()

    const expired = job({ status: 'ready', expiresAt: Date.now() - 1, finishedAt: Date.now() - 3600_000 })
    const fresh = job({ status: 'ready', expiresAt: Date.now() + 3600_000, finishedAt: Date.now() })
    const ancient = job({ status: 'failed', filesPurged: true, createdAt: Date.now() - config.recordTtlMs - 1000, finishedAt: Date.now() - config.recordTtlMs - 1000 })
    const recentFailure = job({ status: 'failed', filesPurged: true, finishedAt: Date.now() - 1000 })
    for (const record of [expired, fresh, ancient, recentFailure]) store.insert(record)

    for (const record of [expired, fresh]) {
      fs.mkdirSync(files.dirFor(record.id), { recursive: true })
      fs.writeFileSync(files.videoPath(record.id), 'video')
    }
    const orphan = '11111111-1111-4111-8111-111111111111'
    fs.mkdirSync(files.dirFor(orphan), { recursive: true })

    queue.sweep()

    expect(fs.existsSync(files.dirFor(expired.id))).toBe(false)
    expect(store.get(expired.id)!.filesPurged).toBe(true)
    expect(fs.existsSync(files.videoPath(fresh.id))).toBe(true)
    expect(fs.existsSync(files.dirFor(orphan))).toBe(false)

    // failed / cancelled хранятся не меньше суток — Todi может прийти за причиной.
    expect(store.get(ancient.id)).toBeNull()
    expect(store.get(recentFailure.id)).not.toBeNull()
  })

  test('нижние границы договора переменной не опустить', async () => {
    const previous = { ...process.env }
    process.env.API_FILE_TTL_MINUTES = '5'
    process.env.API_RECORD_TTL_HOURS = '1'
    try {
      const { loadApiConfig } = await import('./config')
      const config = loadApiConfig()
      expect(config.fileTtlMs).toBe(60 * 60_000)
      expect(config.recordTtlMs).toBe(24 * 60 * 60_000)
    } finally {
      process.env = previous
    }
  })
})

describe('место на томе', () => {
  test('не хватает места — задача ждёт в очереди, а не падает', () => {
    const { store, queue } = setup({ maxStorageBytes: 100 })
    const waiting = job({ maxBytes: 524288000 })
    store.insert(waiting)

    queue.pump()

    expect(store.get(waiting.id)!.status).toBe('queued')
  })
})
