import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'

const COOKIE_NAME = 'vd_client'
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60
const CLIENT_ID_PATTERN = /^[a-f0-9]{32}$/

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      clientId: string
    }
  }
}

/**
 * Анонимный идентификатор браузера. Нужен только чтобы привязать загрузку
 * к тому, кто её запустил: чужой /status и /file получить нельзя.
 */
export function clientIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const existing = readCookie(req.headers.cookie, COOKIE_NAME)

  if (existing && CLIENT_ID_PATTERN.test(existing)) {
    req.clientId = existing
    return next()
  }

  const clientId = crypto.randomBytes(16).toString('hex')
  req.clientId = clientId

  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  const attributes = [
    `${COOKIE_NAME}=${clientId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    secure ? 'Secure' : '',
  ].filter(Boolean)

  res.append('Set-Cookie', attributes.join('; '))
  return next()
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue

    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim()
    }
  }

  return null
}
