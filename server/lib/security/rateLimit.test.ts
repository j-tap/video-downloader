import { describe, expect, test } from 'bun:test'
import type { Request, Response } from 'express'
import { createRateLimiter, getClientIp } from './rateLimit'

interface FakeResponse {
  statusCode: number | null
  body: unknown
  headers: Record<string, string>
}

function makeRes(): { res: Response; captured: FakeResponse } {
  const captured: FakeResponse = { statusCode: null, body: null, headers: {} }

  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value
    },
    status(code: number) {
      captured.statusCode = code
      return res
    },
    json(payload: unknown) {
      captured.body = payload
      return res
    },
  } as unknown as Response

  return { res, captured }
}

/** Прогоняет один запрос через лимитер и говорит, пропустили его или нет. */
function hit(limiter: ReturnType<typeof createRateLimiter>, ip: string) {
  const req = { ip, socket: { remoteAddress: ip }, headers: {} } as unknown as Request
  const { res, captured } = makeRes()
  let passed = false

  limiter(req, res, () => { passed = true })

  return { passed, captured }
}

describe('createRateLimiter', () => {
  test('шестой запрос с одного адреса получает 429', () => {
    const limiter = createRateLimiter({ name: 'test-download', windowMs: 600_000, max: 5, message: 'Слишком много' })

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(hit(limiter, '203.0.113.10').passed).toBe(true)
    }

    const blocked = hit(limiter, '203.0.113.10')
    expect(blocked.passed).toBe(false)
    expect(blocked.captured.statusCode).toBe(429)
    expect(blocked.captured.headers['retry-after']).toBeTruthy()
    expect(blocked.captured.body).toMatchObject({ error: 'Слишком много' })
  })

  test('лимит считается по IP, а не на всех сразу', () => {
    const limiter = createRateLimiter({ name: 'test-per-ip', windowMs: 600_000, max: 2, message: 'stop' })

    hit(limiter, '203.0.113.1')
    hit(limiter, '203.0.113.1')
    expect(hit(limiter, '203.0.113.1').passed).toBe(false)

    // Другой пользователь за тем же Traefik не должен пострадать
    expect(hit(limiter, '203.0.113.2').passed).toBe(true)
  })

  test('лимиты разных маршрутов не пересекаются', () => {
    const download = createRateLimiter({ name: 'test-ns-download', windowMs: 600_000, max: 1, message: 'stop' })
    const api = createRateLimiter({ name: 'test-ns-api', windowMs: 600_000, max: 1, message: 'stop' })

    expect(hit(download, '203.0.113.20').passed).toBe(true)
    expect(hit(download, '203.0.113.20').passed).toBe(false)
    expect(hit(api, '203.0.113.20').passed).toBe(true)
  })

  test('после окончания окна счётчик сбрасывается', async () => {
    const limiter = createRateLimiter({ name: 'test-window', windowMs: 20, max: 1, message: 'stop' })

    expect(hit(limiter, '203.0.113.30').passed).toBe(true)
    expect(hit(limiter, '203.0.113.30').passed).toBe(false)

    await Bun.sleep(30)
    expect(hit(limiter, '203.0.113.30').passed).toBe(true)
  })
})

describe('getClientIp', () => {
  test('берёт req.ip — его express вычисляет с учётом trust proxy', () => {
    const req = { ip: '198.51.100.7', socket: { remoteAddress: '10.0.0.2' } } as unknown as Request
    expect(getClientIp(req)).toBe('198.51.100.7')
  })

  test('падает на адрес сокета, если req.ip пуст', () => {
    const req = { ip: undefined, socket: { remoteAddress: '10.0.0.2' } } as unknown as Request
    expect(getClientIp(req)).toBe('10.0.0.2')
  })
})
