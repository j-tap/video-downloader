import dns from 'dns/promises'
import { isIpLiteral, isPrivateIp } from './ip'

export interface UrlGuardResult {
  ok: boolean
  /** Безопасное для пользователя сообщение */
  error?: string
  /** Детали для лога, наружу не отдаются */
  detail?: string
}

export interface UrlGuardOptions {
  /**
   * Проверять хост по белому списку площадок.
   * Выключается только для ссылок, добытых со страницы уже разрешённой площадки
   * (манифесты kino.pub живут на меняющихся CDN-хостах) — проверки схемы,
   * порта и приватных адресов при этом остаются.
   */
  enforceAllowlist?: boolean
}

const MAX_URL_LENGTH = 2048
const DNS_TIMEOUT_MS = 5000

/** Порты, на которые разрешено ходить. Всё остальное — почти всегда внутренний сервис. */
const ALLOWED_PORTS = new Set(
  (process.env.ALLOWED_PORTS || '80,443')
    .split(',')
    .map((port) => port.trim())
    .filter(Boolean),
)

/**
 * Хосты, которые никогда не резолвятся во внешнюю сеть.
 * Проверяем до DNS, чтобы не зависеть от резолвера.
 */
const BLOCKED_HOSTNAME_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'localdomain',
]

/**
 * Площадки, которые сервис действительно умеет качать (см. getPlatformArgs в downloader).
 * Всё остальное отсекается до запуска yt-dlp: без этого списка сервер работает
 * как открытый прокси и по анонимной ссылке ходит куда угодно, включая docker-сеть.
 */
export const SUPPORTED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'instagram.com',
  'instagr.am',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'kino.pub',
  'cdntogo.net',
] as const

/** Человекочитаемый список для сообщения об ошибке */
const SUPPORTED_PLATFORMS_TEXT = 'YouTube, Instagram, Facebook, kino.pub'

/**
 * ALLOWED_HOSTS=youtube.com,kino.pub — заменить список своим.
 * ALLOWED_HOSTS=* — выключить белый список (остаются проверки схемы, порта
 * и приватных адресов). Пусто — список площадок по умолчанию.
 */
const allowedHostsEnv = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim().toLowerCase().replace(/^\./, ''))
  .filter(Boolean)

const ALLOWED_HOSTS: readonly string[] = allowedHostsEnv.includes('*')
  ? []
  : (allowedHostsEnv.length > 0 ? allowedHostsEnv : SUPPORTED_HOSTS)

export async function assertPublicUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<UrlGuardResult> {
  const syncCheck = checkUrlSync(rawUrl, options)
  if (!syncCheck.ok) return syncCheck

  const hostname = normalizeHostname(new URL(rawUrl.trim()).hostname)

  if (!isIpLiteral(hostname)) {
    const dnsCheck = await checkDnsResolvesToPublic(hostname)
    if (!dnsCheck.ok) return dnsCheck
  }

  return { ok: true }
}

/**
 * Синхронная часть проверки — без DNS. Используется для ссылок,
 * которые мы достаём из страниц источника (манифесты kino.pub).
 */
export function isPublicUrlSync(rawUrl: string, options: UrlGuardOptions = {}): boolean {
  return checkUrlSync(rawUrl, options).ok
}

function checkUrlSync(rawUrl: string, options: UrlGuardOptions = {}): UrlGuardResult {
  const { enforceAllowlist = true } = options

  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, error: 'Не указана ссылка.' }
  }

  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, error: 'Ссылка слишком длинная.' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { ok: false, error: 'Некорректная ссылка.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Поддерживаются только http и https ссылки.' }
  }

  // user:pass@host — типовой способ запутать парсер хоста
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Ссылки с логином и паролем не поддерживаются.' }
  }

  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  if (!ALLOWED_PORTS.has(port)) {
    return {
      ok: false,
      error: 'Разрешены только стандартные порты (80 и 443).',
      detail: `blocked port ${port}`,
    }
  }

  const hostname = normalizeHostname(parsed.hostname)
  if (!hostname) {
    return { ok: false, error: 'Некорректный хост в ссылке.' }
  }

  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) {
      return { ok: false, error: 'Доступ к внутренним адресам запрещён.', detail: `private ip literal ${hostname}` }
    }
  } else {
    const hostnameCheck = checkHostname(hostname)
    if (!hostnameCheck.ok) return hostnameCheck
  }

  if (enforceAllowlist && ALLOWED_HOSTS.length > 0 && !matchesAllowlist(hostname)) {
    return {
      ok: false,
      error: `Этот сайт не поддерживается. Доступны: ${SUPPORTED_PLATFORMS_TEXT}.`,
      detail: `host ${hostname} not in allowlist`,
    }
  }

  return { ok: true }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '')
}

function checkHostname(hostname: string): UrlGuardResult {
  const labels = hostname.split('.')
  const tld = labels[labels.length - 1] || ''

  // Односоставные имена — это имена контейнеров/хостов внутренней сети (mysql, prometheus, …)
  if (labels.length < 2) {
    return { ok: false, error: 'Доступ к внутренним адресам запрещён.', detail: `bare hostname ${hostname}` }
  }

  if (BLOCKED_HOSTNAME_SUFFIXES.includes(tld) || BLOCKED_HOSTNAME_SUFFIXES.includes(hostname)) {
    return { ok: false, error: 'Доступ к внутренним адресам запрещён.', detail: `internal tld ${hostname}` }
  }

  return { ok: true }
}

async function checkDnsResolvesToPublic(hostname: string): Promise<UrlGuardResult> {
  let addresses: Array<{ address: string }>

  try {
    addresses = await withTimeout(dns.lookup(hostname, { all: true, verbatim: true }), DNS_TIMEOUT_MS)
  } catch (error) {
    // Нерезолвящееся имя — не признак внутреннего адреса: при работе через
    // прокси (PROXY/YT_PROXY) имя резолвит прокси, а не мы. Пропускаем —
    // yt-dlp сам вернёт ошибку, если хост действительно недоступен.
    console.warn(`⚠️  DNS lookup failed for ${hostname}: ${(error as Error).message}`)
    return { ok: true }
  }

  if (addresses.length === 0) {
    return { ok: true }
  }

  // Достаточно одного приватного адреса, чтобы отказать: yt-dlp может выбрать именно его.
  const privateAddress = addresses.find(({ address }) => isPrivateIp(address))
  if (privateAddress) {
    return {
      ok: false,
      error: 'Доступ к внутренним адресам запрещён.',
      detail: `${hostname} resolves to private ${privateAddress.address}`,
    }
  }

  return { ok: true }
}

function matchesAllowlist(hostname: string): boolean {
  return ALLOWED_HOSTS.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
