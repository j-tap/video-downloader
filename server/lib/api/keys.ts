import crypto from 'crypto'

/**
 * Ключи API: `API_KEYS=todi:<секрет>,другой:<секрет>`. Секрет живёт только
 * в окружении; в журнал попадает имя. Отозванный ключ переносится
 * в `API_KEYS_REVOKED` — тогда он получает 403, а не 401, и по журналу видно,
 * что стучится старый клиент, а не случайный прохожий.
 */

export interface ApiKey {
  name: string
  /** sha256 секрета: сравниваем отпечатки одной длины, а не строки разной */
  digest: Buffer
}

export interface KeyRing {
  active: ApiKey[]
  revoked: ApiKey[]
}

export type AuthResult =
  | { ok: true; name: string }
  | { ok: false; code: 'unauthorized' | 'forbidden'; name?: string }

const KEY_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MIN_SECRET_LENGTH = 32

export function parseKeyList(raw: string | undefined): { keys: ApiKey[]; problems: string[] } {
  const keys: ApiKey[] = []
  const problems: string[] = []
  const names = new Set<string>()

  for (const item of (raw || '').split(',')) {
    const trimmed = item.trim()
    if (!trimmed) continue

    const separator = trimmed.indexOf(':')
    const name = separator > 0 ? trimmed.slice(0, separator).trim() : ''
    const secret = separator > 0 ? trimmed.slice(separator + 1).trim() : ''

    // Сам элемент в сообщение не кладём: в нём секрет.
    if (!KEY_NAME.test(name) || !secret) {
      problems.push(`элемент №${keys.length + problems.length + 1}: нужен вид имя:секрет`)
      continue
    }

    if (names.has(name)) {
      problems.push(`ключ «${name}» указан дважды`)
      continue
    }

    if (secret.length < MIN_SECRET_LENGTH) {
      problems.push(`ключ «${name}» короче ${MIN_SECRET_LENGTH} символов — сгенерируйте новый`)
    }

    names.add(name)
    keys.push({ name, digest: digest(secret) })
  }

  return { keys, problems }
}

export function loadKeyRing(env: Record<string, string | undefined> = process.env): { ring: KeyRing; problems: string[] } {
  const active = parseKeyList(env.API_KEYS)
  const revoked = parseKeyList(env.API_KEYS_REVOKED)

  return {
    ring: { active: active.keys, revoked: revoked.keys },
    problems: [
      ...active.problems.map((problem) => `API_KEYS: ${problem}`),
      ...revoked.problems.map((problem) => `API_KEYS_REVOKED: ${problem}`),
    ],
  }
}

/**
 * Сверяем со всеми ключами без раннего выхода и за постоянное время:
 * по задержке ответа нельзя угадать ни секрет, ни сколько ключей настроено.
 */
export function authenticate(header: string | undefined, ring: KeyRing): AuthResult {
  const token = parseBearer(header)
  if (!token) return { ok: false, code: 'unauthorized' }

  const provided = digest(token)
  let activeName: string | null = null
  let revokedName: string | null = null

  for (const key of ring.active) {
    if (crypto.timingSafeEqual(provided, key.digest)) activeName ??= key.name
  }

  for (const key of ring.revoked) {
    if (crypto.timingSafeEqual(provided, key.digest)) revokedName ??= key.name
  }

  if (activeName) return { ok: true, name: activeName }
  if (revokedName) return { ok: false, code: 'forbidden', name: revokedName }
  return { ok: false, code: 'unauthorized' }
}

function parseBearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer[ \t]+(\S+)\s*$/i)
  return match?.[1] ?? null
}

function digest(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest()
}
