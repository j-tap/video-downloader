import crypto from 'crypto'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import type { ApiConfig } from './config'
import { JobFiles } from './files'
import { loadKeyRing } from './keys'
import { setLogSink } from './log'
import { JobQueue, type ExecHooks, type ExecResult, type Executor } from './queue'
import { JobStore, type JobRecord } from './store'
import { createApiV1Router } from '../../routes/apiV1'
import type { UrlGuardResult } from '../security/urlGuard'

/**
 * Обвязка для тестов API: настоящие маршруты, очередь и SQLite в памяти,
 * но вместо yt-dlp — исполнитель, которым тест управляет сам.
 */

export const TODI_SECRET = 'TodiSecretTodiSecretTodiSecretTodiSecret0'
export const OTHER_SECRET = 'OtherSecretOtherSecretOtherSecretOtherSe1'
export const REVOKED_SECRET = 'RevokedSecretRevokedSecretRevokedSecretR2'

export interface PendingRun {
  job: JobRecord
  hooks: ExecHooks
  signal: AbortSignal
  resolve: (result: ExecResult) => void
}

/** Исполнитель, задачи которого висят, пока тест не завершит их сам. */
export function controllableExecutor() {
  const runs = new Map<string, PendingRun>()

  const executor: Executor = (job, hooks, signal) => new Promise<ExecResult>((resolve) => {
    runs.set(job.id, { job, hooks, signal, resolve })
    signal.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled' }), { once: true })
  })

  return { executor, runs }
}

export function testConfig(dataDir: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    dataDir,
    fileTtlMs: 60 * 60_000,
    recordTtlMs: 24 * 60 * 60_000,
    serverMaxActive: 3,
    maxActiveTotal: 2,
    maxActivePerKey: 2,
    maxQueuedPerKey: 20,
    maxJobsPerHour: 60,
    maxStorageBytes: 100 * 1024 ** 3,
    jobTimeoutMs: 30 * 60_000,
    maxDurationSec: 4 * 3600,
    maxBytes: 4 * 1024 ** 3,
    maxHeight: 1080,
    maxRestarts: 2,
    ...overrides,
  }
}

export interface HarnessOptions {
  apiKeys?: string
  config?: Partial<ApiConfig>
  executor?: Executor
  siteActive?: () => number
  checkUrl?: (url: string) => Promise<UrlGuardResult>
}

export async function createHarness(options: HarnessOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-api-test-'))
  const store = new JobStore(':memory:')
  const files = new JobFiles(dataDir)
  const config = testConfig(dataDir, options.config)
  const control = controllableExecutor()
  const siteActive = options.siteActive ?? (() => 0)

  const queue = new JobQueue({
    store,
    files,
    config,
    executor: options.executor ?? control.executor,
    siteActive,
  })

  const { ring } = loadKeyRing({
    API_KEYS: options.apiKeys ?? `todi:${TODI_SECRET},other:${OTHER_SECRET}`,
    API_KEYS_REVOKED: `old:${REVOKED_SECRET}`,
  })

  const logs: Array<Record<string, unknown>> = []
  const rawLogs: string[] = []
  const previousSink = setLogSink((line) => {
    rawLogs.push(line)
    logs.push(JSON.parse(line))
  })

  const app = express()
  app.use('/api/v1', createApiV1Router({
    store,
    queue,
    files,
    config,
    keyRing: ring,
    ytDlpVersion: '2026.11.01',
    siteActive,
    checkUrl: options.checkUrl ?? (async () => ({ ok: true })),
  }))

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}/api/v1`

  async function call(method: string, pathname: string, init: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers }
    const key = init.key === undefined ? TODI_SECRET : init.key
    if (key) headers.Authorization = `Bearer ${key}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    })
    const type = response.headers.get('content-type') || ''
    const body = type.includes('application/json') ? await response.json() : await response.arrayBuffer()
    return { status: response.status, headers: response.headers, body: body as any }
  }

  async function createJob(url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, key?: string) {
    return call('POST', '/jobs', { body: { url, ...extra }, headers, key })
  }

  /** Довести задачу до ready с настоящим файлом на диске. */
  function completeWithFile(id: string, content: Buffer, thumbnail?: Buffer) {
    const run = control.runs.get(id)
    if (!run) throw new Error(`no run for ${id}`)
    fs.mkdirSync(files.dirFor(id), { recursive: true })
    fs.writeFileSync(files.videoPath(id), content)
    if (thumbnail) fs.writeFileSync(files.thumbnailPath(id), thumbnail)
    run.resolve({
      ok: true,
      file: {
        sizeBytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        width: 1280,
        height: 720,
        durationSec: 10,
        hasThumbnail: Boolean(thumbnail),
      },
    })
  }

  async function close() {
    await queue.stop()
    await new Promise((resolve) => server.close(resolve))
    setLogSink(previousSink)
    store.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }

  /** Дать промисам очереди отработать. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  return { store, files, queue, config, control, call, createJob, completeWithFile, close, settle, logs, rawLogs, dataDir }
}
