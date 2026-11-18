import { Database } from 'bun:sqlite'

/**
 * Записи о задачах API — в SQLite на томе. Память процесса не годится:
 * после перезапуска Todi должна получить свою задачу или честный
 * `404 job_not_found`, а не опрашивать то, чего никто больше не помнит.
 */

export type JobStatus = 'queued' | 'downloading' | 'processing' | 'ready' | 'failed' | 'cancelled'

export const FINISHED: readonly JobStatus[] = ['ready', 'failed', 'cancelled']
export const RUNNING: readonly JobStatus[] = ['downloading', 'processing']

export interface JobRecord {
  id: string
  keyName: string
  idempotencyKey: string | null
  requestId: string
  url: string
  host: string
  maxDurationSec: number
  maxBytes: number
  maxHeight: number
  status: JobStatus
  progress: number
  title: string | null
  uploader: string | null
  durationSec: number | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  sha256: string | null
  extractor: string | null
  sourceId: string | null
  webpageUrl: string | null
  hasThumbnail: boolean
  errorCode: string | null
  errorMessage: string | null
  /** Сколько раз задачу прервал перезапуск сервиса */
  restarts: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  expiresAt: number | null
  /** Файлы стёрты (забраны, истекли или задача не удалась) */
  filesPurged: boolean
}

export type JobPatch = Partial<Omit<JobRecord, 'id' | 'keyName' | 'createdAt'>>

const COLUMNS: Record<keyof JobRecord, string> = {
  id: 'id',
  keyName: 'key_name',
  idempotencyKey: 'idempotency_key',
  requestId: 'request_id',
  url: 'url',
  host: 'host',
  maxDurationSec: 'max_duration_sec',
  maxBytes: 'max_bytes',
  maxHeight: 'max_height',
  status: 'status',
  progress: 'progress',
  title: 'title',
  uploader: 'uploader',
  durationSec: 'duration_sec',
  width: 'width',
  height: 'height',
  sizeBytes: 'size_bytes',
  sha256: 'sha256',
  extractor: 'extractor',
  sourceId: 'source_id',
  webpageUrl: 'webpage_url',
  hasThumbnail: 'has_thumbnail',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  restarts: 'restarts',
  createdAt: 'created_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  expiresAt: 'expires_at',
  filesPurged: 'files_purged',
}

const BOOLEAN_FIELDS = new Set<keyof JobRecord>(['hasThumbnail', 'filesPurged'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  key_name TEXT NOT NULL,
  idempotency_key TEXT,
  request_id TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  max_duration_sec INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  max_height INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  title TEXT,
  uploader TEXT,
  duration_sec INTEGER,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  sha256 TEXT,
  extractor TEXT,
  source_id TEXT,
  webpage_url TEXT,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  restarts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  expires_at INTEGER,
  files_purged INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs (key_name, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_key_created ON jobs (key_name, created_at);
`

type Row = Record<string, string | number | null>

export class JobStore {
  private readonly db: Database

  constructor(file: string) {
    this.db = new Database(file, { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  insert(job: JobRecord): void {
    const keys = Object.keys(COLUMNS) as Array<keyof JobRecord>
    const columns = keys.map((key) => COLUMNS[key])
    this.db
      .query(`INSERT INTO jobs (${columns.join(', ')}) VALUES (${columns.map((column) => `$${column}`).join(', ')})`)
      .run(toRow(job) as never)
  }

  get(id: string): JobRecord | null {
    const row = this.db.query('SELECT * FROM jobs WHERE id = $id').get({ id }) as Row | null
    return row ? fromRow(row) : null
  }

  /** Задачи принадлежат ключу: чужой ключ не отличит чужую задачу от несуществующей. */
  getForKey(id: string, keyName: string): JobRecord | null {
    const job = this.get(id)
    return job && job.keyName === keyName ? job : null
  }

  findByIdempotencyKey(keyName: string, idempotencyKey: string, since: number): JobRecord | null {
    const row = this.db
      .query('SELECT * FROM jobs WHERE key_name = $keyName AND idempotency_key = $idempotencyKey AND created_at >= $since')
      .get({ keyName, idempotencyKey, since }) as Row | null
    return row ? fromRow(row) : null
  }

  /** Срок Idempotency-Key вышел, а запись ещё хранится — ключ освобождаем для новой задачи. */
  releaseIdempotencyKey(keyName: string, idempotencyKey: string, before: number): void {
    this.db
      .query('UPDATE jobs SET idempotency_key = NULL WHERE key_name = $keyName AND idempotency_key = $idempotencyKey AND created_at < $before')
      .run({ keyName, idempotencyKey, before })
  }

  update(id: string, patch: JobPatch): void {
    const keys = (Object.keys(patch) as Array<keyof JobPatch>).filter((key) => patch[key] !== undefined)
    if (keys.length === 0) return

    const assignments = keys.map((key) => `${COLUMNS[key]} = $${COLUMNS[key]}`).join(', ')
    const params: Record<string, string | number | null> = { id }
    for (const key of keys) params[COLUMNS[key]] = toColumn(key, patch[key])

    this.db.query(`UPDATE jobs SET ${assignments} WHERE id = $id`).run(params as never)
  }

  listByStatus(statuses: readonly JobStatus[]): JobRecord[] {
    const placeholders = statuses.map((_, index) => `$s${index}`).join(', ')
    const params = Object.fromEntries(statuses.map((status, index) => [`s${index}`, status]))
    const rows = this.db
      .query(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at, rowid`)
      .all(params as never) as Row[]
    return rows.map(fromRow)
  }

  /** Ready-задачи с живыми файлами — для истечения срока и сборщика сирот. */
  listWithFiles(): JobRecord[] {
    const rows = this.db.query('SELECT * FROM jobs WHERE files_purged = 0').all() as Row[]
    return rows.map(fromRow)
  }

  countByKey(keyName: string, statuses: readonly JobStatus[]): number {
    const placeholders = statuses.map((_, index) => `$s${index}`).join(', ')
    const params = { keyName, ...Object.fromEntries(statuses.map((status, index) => [`s${index}`, status])) }
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM jobs WHERE key_name = $keyName AND status IN (${placeholders})`)
      .get(params as never) as { n: number }
    return row.n
  }

  countByStatus(statuses: readonly JobStatus[]): number {
    return this.listByStatus(statuses).length
  }

  /** Время создания задач ключа за окно, по возрастанию — для предела «N в час». */
  creationTimesSince(keyName: string, since: number): number[] {
    const rows = this.db
      .query('SELECT created_at FROM jobs WHERE key_name = $keyName AND created_at >= $since ORDER BY created_at')
      .all({ keyName, since }) as Array<{ created_at: number }>
    return rows.map((row) => row.created_at)
  }

  /** Стирает записи завершённых задач старше срока. Возвращает, сколько стёрто. */
  purgeFinishedBefore(before: number): number {
    const result = this.db
      .query(`DELETE FROM jobs WHERE status IN ('ready', 'failed', 'cancelled') AND files_purged = 1
              AND COALESCE(finished_at, created_at) < $before AND created_at < $before`)
      .run({ before })
    return result.changes
  }
}

function toRow(job: JobRecord): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {}
  for (const key of Object.keys(COLUMNS) as Array<keyof JobRecord>) {
    row[COLUMNS[key]] = toColumn(key, job[key])
  }
  return row
}

function toColumn(key: keyof JobRecord, value: unknown): string | number | null {
  if (BOOLEAN_FIELDS.has(key)) return value ? 1 : 0
  if (value === undefined || value === null) return null
  return value as string | number
}

function fromRow(row: Row): JobRecord {
  const job: Record<string, unknown> = {}
  for (const key of Object.keys(COLUMNS) as Array<keyof JobRecord>) {
    const value = row[COLUMNS[key]]
    job[key] = BOOLEAN_FIELDS.has(key) ? Boolean(value) : value ?? null
  }
  return job as unknown as JobRecord
}
