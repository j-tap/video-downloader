import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHarness, OTHER_SECRET, REVOKED_SECRET, TODI_SECRET } from '../lib/api/testing'

type Harness = Awaited<ReturnType<typeof createHarness>>

/** Ошибка всегда одного вида — договор, «Запросы сервиса». */
function expectError(body: any, code: string, retryable: boolean) {
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
      retryable,
      retryAfterSec: body?.error?.retryAfterSec ?? null,
    },
  })
}

describe('ключ', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('нет ключа — 401 unauthorized в формате договора', async () => {
    const response = await h.call('GET', '/health', { key: null })
    expect(response.status).toBe(401)
    expectError(response.body, 'unauthorized', false)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  test('неверный ключ — 401', async () => {
    const response = await h.call('POST', '/jobs', { key: 'wrong', body: { url: 'https://youtu.be/dQw4w9WgXcQ' } })
    expect(response.status).toBe(401)
    expectError(response.body, 'unauthorized', false)
    expect(h.store.listByStatus(['queued', 'downloading'])).toHaveLength(0)
  })

  test('отозванный ключ — 403 forbidden, в журнале имя ключа и ни следа секрета', async () => {
    const response = await h.call('GET', '/health', { key: REVOKED_SECRET })
    expect(response.status).toBe(403)
    expectError(response.body, 'forbidden', false)

    const denied = h.logs.find((line) => line.event === 'auth.denied')
    expect(denied).toMatchObject({ key: 'old', code: 'forbidden' })
    expect(h.rawLogs.join('\n')).not.toContain(REVOKED_SECRET)
  })

  test('верный ключ — проходит', async () => {
    const response = await h.call('GET', '/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, ytDlp: '2026.11.01', active: 0, queued: 0, maxActive: 3 })
  })

  test('без CORS и без куки сайта', async () => {
    const response = await h.call('GET', '/health', { headers: { Origin: 'https://evil.example' } })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})

describe('пустой API_KEYS', () => {
  test('весь /api/v1 отвечает 401', async () => {
    const h = await createHarness({ apiKeys: '' })
    try {
      for (const [method, pathname] of [['GET', '/health'], ['POST', '/jobs'], ['GET', '/jobs/00000000-0000-4000-8000-000000000000']] as const) {
        const response = await h.call(method, pathname, { body: method === 'POST' ? { url: 'https://youtu.be/x' } : undefined })
        expect(response.status).toBe(401)
        expectError(response.body, 'unauthorized', false)
      }
    } finally {
      await h.close()
    }
  })
})

describe('X-Request-Id', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('возвращается в ответе и попадает в каждую строку журнала по задаче', async () => {
    const created = await h.createJob(undefined, {}, { 'X-Request-Id': 'todi-video-42' })
    expect(created.headers.get('x-request-id')).toBe('todi-video-42')

    const status = await h.call('GET', `/jobs/${created.body.id}`, { headers: { 'X-Request-Id': 'todi-video-42' } })
    expect(status.headers.get('x-request-id')).toBe('todi-video-42')

    await h.call('DELETE', `/jobs/${created.body.id}`, { headers: { 'X-Request-Id': 'todi-video-42' } })
    await h.settle()

    const jobLines = h.logs.filter((line) => line.jobId === created.body.id)
    expect(jobLines.map((line) => line.event)).toEqual(expect.arrayContaining(['job.created', 'job.started', 'job.cancelled']))
    for (const line of jobLines) expect(line.requestId).toBe('todi-video-42')
    for (const line of jobLines) expect(line.key).toBe('todi')
  })

  test('без заголовка — сервис выдаёт свой', async () => {
    const response = await h.call('GET', '/health')
    expect(response.headers.get('x-request-id')).toMatch(/^vd-/)
  })
})

describe('POST /jobs', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('202 и задача в очереди; пределы — меньшее из своих и пришедших', async () => {
    const response = await h.createJob('https://youtu.be/dQw4w9WgXcQ', { maxDurationSec: 1800, maxBytes: 524288000, maxHeight: 99999 })
    expect(response.status).toBe(202)
    expect(response.body).toEqual({ id: expect.any(String), status: 'queued' })

    const job = h.store.get(response.body.id)!
    expect(job.maxDurationSec).toBe(1800)
    expect(job.maxBytes).toBe(524288000)
    expect(job.maxHeight).toBe(1080)
  })

  test('ссылка видна сразу: url_invalid, site_unsupported, playlist_not_allowed', async () => {
    const cases: Array<[unknown, string]> = [
      [{}, 'url_invalid'],
      [{ url: 'не ссылка' }, 'url_invalid'],
      [{ url: 'http://127.0.0.1/video.mp4' }, 'url_invalid'],
      [{ url: 'ftp://youtube.com/x' }, 'url_invalid'],
      [{ url: 'https://vimeo.com/76979871' }, 'site_unsupported'],
      [{ url: 'https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE' }, 'playlist_not_allowed'],
      [{ url: 'https://www.youtube.com/@google' }, 'playlist_not_allowed'],
      [{ url: 'https://www.tiktok.com/@someone' }, 'playlist_not_allowed'],
      [{ url: 'https://rutube.ru/plst/12345/' }, 'playlist_not_allowed'],
    ]

    for (const [body, code] of cases) {
      const response = await h.call('POST', '/jobs', { body })
      expect(response.status).toBe(400)
      expectError(response.body, code, false)
    }
    expect(h.store.listByStatus(['queued', 'downloading'])).toHaveLength(0)
  })

  test('ролик внутри плейлиста — это ролик', async () => {
    const response = await h.createJob('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLBCF2DAC6FFB574DE')
    expect(response.status).toBe(202)
  })

  test('новые площадки проходят белый список', async () => {
    for (const url of [
      'https://www.tiktok.com/@user/video/7206382937372134662',
      'https://vm.tiktok.com/ZMabcdef/',
      'https://vt.tiktok.com/ZSabcdef/',
      'https://vk.com/video-50883936_456244102',
      'https://vkvideo.ru/video-50883936_456244102',
      'https://vk.ru/video-220754053_456242564',
      'https://rutube.ru/video/3eac3b4561676c17df9132a9a1e62e3e/',
    ]) {
      const response = await h.createJob(url)
      expect(response.status).toBe(202)
    }
  })

  test('сетевая проверка ссылки (редирект во внутреннюю сеть) — url_invalid', async () => {
    await h.close()
    h = await createHarness({
      checkUrl: async () => ({ ok: false, code: 'url_invalid', error: 'Ссылка перенаправляет на внутренний адрес.' }),
    })
    const response = await h.createJob('https://vm.tiktok.com/ZMabcdef/')
    expect(response.status).toBe(400)
    expectError(response.body, 'url_invalid', false)
  })

  test('неразборчивое тело — 400 bad_request в том же формате', async () => {
    const broken = await h.call('POST', '/jobs', { body: '{"url":' })
    expect(broken.status).toBe(400)
    expectError(broken.body, 'bad_request', false)

    const badLimit = await h.createJob(undefined, { maxBytes: 'много' })
    expect(badLimit.status).toBe(400)
    expectError(badLimit.body, 'bad_request', false)
  })

  test('неизвестный адрес — 404 в формате договора', async () => {
    const response = await h.call('GET', '/nope')
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('bad_request')
  })
})

describe('Idempotency-Key', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('повтор с тем же ключом — та же задача, а не вторая', async () => {
    const headers = { 'Idempotency-Key': 'todi-video-7' }
    const first = await h.createJob(undefined, {}, headers)
    const second = await h.createJob(undefined, {}, headers)

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(second.body.id).toBe(first.body.id)
    expect(h.store.listByStatus(['queued', 'downloading'])).toHaveLength(1)
  })

  test('новая попытка — новый ключ, новая задача', async () => {
    const first = await h.createJob(undefined, {}, { 'Idempotency-Key': 'todi-video-7' })
    const retry = await h.createJob(undefined, {}, { 'Idempotency-Key': 'todi-video-7.2' })
    expect(retry.body.id).not.toBe(first.body.id)
  })

  test('одинаковый Idempotency-Key у разных ключей API — разные задачи', async () => {
    const todi = await h.createJob(undefined, {}, { 'Idempotency-Key': 'same' })
    const other = await h.createJob(undefined, {}, { 'Idempotency-Key': 'same' }, OTHER_SECRET)
    expect(other.body.id).not.toBe(todi.body.id)
  })

  test('повтор не упирается в пределы', async () => {
    await h.close()
    h = await createHarness({ config: { maxJobsPerHour: 1 } })
    const headers = { 'Idempotency-Key': 'todi-video-9' }
    const first = await h.createJob(undefined, {}, headers)
    const replay = await h.createJob(undefined, {}, headers)
    expect(replay.status).toBe(202)
    expect(replay.body.id).toBe(first.body.id)
  })
})

describe('задачи принадлежат ключу', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('чужой ключ видит 404 job_not_found и не может отменить', async () => {
    const created = await h.createJob()
    const id = created.body.id

    for (const pathname of [`/jobs/${id}`, `/jobs/${id}/file`, `/jobs/${id}/thumbnail`]) {
      const response = await h.call('GET', pathname, { key: OTHER_SECRET })
      expect(response.status).toBe(404)
      expectError(response.body, 'job_not_found', true)
    }

    const deleted = await h.call('DELETE', `/jobs/${id}`, { key: OTHER_SECRET })
    expect(deleted.status).toBe(204)
    expect(h.store.get(id)!.status).toBe('downloading')
  })

  test('несуществующая задача и мусор вместо id — тоже job_not_found', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', '..%2F..%2Fetc', 'x']) {
      const response = await h.call('GET', `/jobs/${id}`)
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('job_not_found')
    }
  })
})

describe('очередь и пределы на ключ', () => {
  test('две в работе, остальные ждут; переполненная очередь — 503 queue_full с Retry-After', async () => {
    const h = await createHarness({ config: { maxQueuedPerKey: 3 } })
    try {
      const ids: string[] = []
      for (let index = 0; index < 5; index += 1) {
        const response = await h.createJob()
        expect(response.status).toBe(202)
        ids.push(response.body.id)
      }

      expect(h.store.listByStatus(['downloading']).map((job) => job.id)).toEqual(ids.slice(0, 2))
      expect(h.store.listByStatus(['queued']).map((job) => job.id)).toEqual(ids.slice(2))

      const overflow = await h.createJob()
      expect(overflow.status).toBe(503)
      expectError(overflow.body, 'queue_full', true)
      expect(Number(overflow.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(overflow.body.error.retryAfterSec).toBe(Number(overflow.headers.get('retry-after')))

      // Освободилось место — следующая из очереди уходит в работу сама.
      h.control.runs.get(ids[0]!)!.resolve({ ok: false, code: 'not_found' })
      await h.settle()
      expect(h.store.get(ids[2]!)!.status).toBe('downloading')
    } finally {
      await h.close()
    }
  })

  test('ключи не делят свой предел: у другого ключа свои две', async () => {
    const h = await createHarness({ config: { maxActiveTotal: 4, serverMaxActive: 5 } })
    try {
      for (let index = 0; index < 3; index += 1) await h.createJob()
      const other = await h.createJob(undefined, {}, {}, OTHER_SECRET)
      expect(h.store.get(other.body.id)!.status).toBe('downloading')
      expect(h.store.listByStatus(['downloading'])).toHaveLength(3)
    } finally {
      await h.close()
    }
  })

  test('общий потолок сервера делится с сайтом', async () => {
    let siteActive = 2
    const h = await createHarness({ siteActive: () => siteActive })
    try {
      await h.createJob()
      await h.createJob()
      // Потолок 3, сайт занял 2 — API достаётся одна.
      expect(h.store.listByStatus(['downloading'])).toHaveLength(1)
      expect(h.store.listByStatus(['queued'])).toHaveLength(1)

      siteActive = 0
      h.queue.pump()
      expect(h.store.listByStatus(['downloading'])).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  test('API не съедает потолок целиком: сайту остаётся место', async () => {
    const h = await createHarness({ config: { maxActivePerKey: 5 } })
    try {
      for (let index = 0; index < 4; index += 1) await h.createJob()
      expect(h.store.listByStatus(['downloading'])).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  test('больше 60 новых в час — 429 rate_limited с Retry-After', async () => {
    const h = await createHarness({ config: { maxJobsPerHour: 3, maxQueuedPerKey: 100 } })
    try {
      for (let index = 0; index < 3; index += 1) expect((await h.createJob()).status).toBe(202)
      const limited = await h.createJob()
      expect(limited.status).toBe(429)
      expectError(limited.body, 'rate_limited', true)
      const retryAfter = Number(limited.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThan(3500)
      expect(retryAfter).toBeLessThanOrEqual(3600)
    } finally {
      await h.close()
    }
  })
})

describe('состояние задачи', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('метаданные появляются по мере работы, ошибка — в формате договора', async () => {
    const { body } = await h.createJob()
    const run = h.control.runs.get(body.id)!
    run.hooks.setMeta({ title: 'Ролик', durationSec: 312, extractor: 'youtube', sourceId: 'dQw4w9WgXcQ' })
    run.hooks.setProgress(42.7)

    const running = await h.call('GET', `/jobs/${body.id}`)
    expect(running.body).toMatchObject({ id: body.id, status: 'downloading', progress: 42, title: 'Ролик', durationSec: 312, error: null })

    run.resolve({ ok: false, code: 'too_long', output: 'duration 4000 > 1800' })
    await h.settle()

    const failed = await h.call('GET', `/jobs/${body.id}`)
    expect(failed.body.status).toBe('failed')
    expect(failed.body.error).toEqual({ code: 'too_long', message: expect.any(String), retryable: false, retryAfterSec: null })

    const line = h.logs.find((entry) => entry.event === 'job.failed')
    expect(line).toMatchObject({ jobId: body.id, code: 'too_long', ytDlpTail: 'duration 4000 > 1800' })
  })

  test('прогресс не откатывается назад', async () => {
    const { body } = await h.createJob()
    const run = h.control.runs.get(body.id)!
    run.hooks.setProgress(80)
    run.hooks.setProgress(5)
    expect(h.store.get(body.id)!.progress).toBe(80)
  })

  test('незнакомый код не уходит наружу: становится internal', async () => {
    const { body } = await h.createJob()
    h.control.runs.get(body.id)!.resolve({ ok: false, code: 'weird_code' as never })
    await h.settle()
    const failed = await h.call('GET', `/jobs/${body.id}`)
    expect(failed.body.error.code).toBe('internal')
    expect(failed.body.error.retryable).toBe(true)
  })
})

describe('файл', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  const content = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251))

  test('не готов — 409 not_ready', async () => {
    const { body } = await h.createJob()
    const response = await h.call('GET', `/jobs/${body.id}/file`)
    expect(response.status).toBe(409)
    expectError(response.body, 'not_ready', true)
  })

  test('целиком: Content-Length, ETag, X-Content-SHA256, Accept-Ranges', async () => {
    const { body } = await h.createJob()
    h.completeWithFile(body.id, content)
    await h.settle()

    const status = await h.call('GET', `/jobs/${body.id}`)
    expect(status.body).toMatchObject({ status: 'ready', progress: 100, sizeBytes: 1000, hasThumbnail: false })
    expect(Date.parse(status.body.expiresAt)).toBeGreaterThan(Date.now() + 59 * 60_000)

    const file = await h.call('GET', `/jobs/${body.id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('video/mp4')
    expect(file.headers.get('content-length')).toBe('1000')
    expect(file.headers.get('accept-ranges')).toBe('bytes')
    expect(file.headers.get('etag')).toBe(`"${status.body.sha256}"`)
    expect(file.headers.get('x-content-sha256')).toBe(status.body.sha256)
    expect(Buffer.from(file.body)).toEqual(content)
  })

  test('Range: докачка с места обрыва', async () => {
    const { body } = await h.createJob()
    h.completeWithFile(body.id, content)
    await h.settle()

    const head = await h.call('GET', `/jobs/${body.id}/file`, { headers: { Range: 'bytes=0-9' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe('bytes 0-9/1000')
    expect(Buffer.from(head.body)).toEqual(content.subarray(0, 10))

    const rest = await h.call('GET', `/jobs/${body.id}/file`, { headers: { Range: 'bytes=990-' } })
    expect(rest.status).toBe(206)
    expect(rest.headers.get('content-range')).toBe('bytes 990-999/1000')
    expect(Buffer.from(rest.body)).toEqual(content.subarray(990))

    // Файл подменили между попытками — If-Range не совпал, отдаём целиком.
    const stale = await h.call('GET', `/jobs/${body.id}/file`, { headers: { Range: 'bytes=10-', 'If-Range': '"other-etag"' } })
    expect(stale.status).toBe(200)
    expect(Buffer.from(stale.body)).toEqual(content)

    const served = h.logs.filter((line) => line.event === 'file.served')
    expect(served.map((line) => line.range)).toEqual(['bytes=0-9', 'bytes=990-', 'bytes=10-'])
  })

  test('после DELETE — 410 file_expired, повторный DELETE — тоже 204', async () => {
    const { body } = await h.createJob()
    h.completeWithFile(body.id, content)
    await h.settle()

    expect((await h.call('DELETE', `/jobs/${body.id}`)).status).toBe(204)
    expect((await h.call('DELETE', `/jobs/${body.id}`)).status).toBe(204)

    const file = await h.call('GET', `/jobs/${body.id}/file`)
    expect(file.status).toBe(410)
    expectError(file.body, 'file_expired', true)
    expect(h.files.listIds()).not.toContain(body.id)
    expect(h.logs.filter((line) => line.event === 'job.deleted')).toHaveLength(1)
  })

  test('обложка: есть — jpeg, нет — 404 no_thumbnail', async () => {
    const first = await h.createJob()
    h.completeWithFile(first.body.id, content, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const second = await h.createJob()
    h.completeWithFile(second.body.id, content)
    await h.settle()

    const thumbnail = await h.call('GET', `/jobs/${first.body.id}/thumbnail`)
    expect(thumbnail.status).toBe(200)
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg')

    const missing = await h.call('GET', `/jobs/${second.body.id}/thumbnail`)
    expect(missing.status).toBe(404)
    expectError(missing.body, 'no_thumbnail', false)
  })
})

describe('DELETE /jobs/:id', () => {
  let h: Harness
  beforeEach(async () => { h = await createHarness() })
  afterEach(() => h.close())

  test('идущую задачу останавливает: статус cancelled сразу, процесс получает отмену', async () => {
    const { body } = await h.createJob()
    const run = h.control.runs.get(body.id)!

    const response = await h.call('DELETE', `/jobs/${body.id}`)
    expect(response.status).toBe(204)
    expect(run.signal.aborted).toBe(true)

    const status = await h.call('GET', `/jobs/${body.id}`)
    expect(status.body.status).toBe('cancelled')
    expect(status.body.error.code).toBe('cancelled')

    // Задача из очереди встаёт на освободившееся место.
    await h.settle()
    expect(h.queue.activeCount()).toBe(0)
  })

  test('ждущую в очереди снимает без запуска', async () => {
    await h.createJob()
    await h.createJob()
    const waiting = await h.createJob()
    expect(h.store.get(waiting.body.id)!.status).toBe('queued')

    await h.call('DELETE', `/jobs/${waiting.body.id}`)
    expect(h.store.get(waiting.body.id)!.status).toBe('cancelled')
    expect(h.control.runs.has(waiting.body.id)).toBe(false)
  })

  test('неизвестная задача — 204: удалять удалённое не ошибка', async () => {
    const response = await h.call('DELETE', '/jobs/00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(204)
  })
})

describe('журнал', () => {
  test('секрет ключа и Authorization не пишутся никогда', async () => {
    const h = await createHarness()
    try {
      await h.createJob(undefined, {}, { 'X-Request-Id': 'todi-video-1' })
      await h.call('GET', '/health', { key: 'wrong-key-wrong-key-wrong-key' })
      await h.call('GET', '/health', { key: REVOKED_SECRET })
      const all = h.rawLogs.join('\n')
      expect(all).not.toContain(TODI_SECRET)
      expect(all).not.toContain(REVOKED_SECRET)
      expect(all).not.toContain('wrong-key')
      expect(all.toLowerCase()).not.toContain('bearer')
      for (const line of h.logs) {
        expect(line).toHaveProperty('ts')
        expect(line).toHaveProperty('level')
        expect(line).toHaveProperty('event')
      }
    } finally {
      await h.close()
    }
  })
})
