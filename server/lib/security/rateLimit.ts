import type { NextFunction, Request, Response } from 'express'

interface Bucket {
  count: number
  resetAt: number
}

export interface RateLimitOptions {
  windowMs: number
  max: number
  message: string
  /** Отдельное пространство ключей, чтобы лимиты не пересекались */
  name: string
}

const buckets = new Map<string, Bucket>()

// Периодически чистим протухшие корзины, чтобы Map не рос бесконечно.
const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}, 60_000)
cleanupTimer.unref?.()

export function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, message, name } = options

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const key = `${name}:${getClientIp(req)}`
    const now = Date.now()
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    bucket.count += 1

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ error: message, retryAfter })
      return
    }

    next()
  }
}

export function readRateLimitEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
