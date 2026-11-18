import dns from 'dns/promises'
import { isIpLiteral, isPrivateIp } from './ip'

export interface UrlGuardResult {
  ok: boolean
  /**
   * Машинный код отказа для API: хост вне белого списка — `site_unsupported`,
   * всё остальное (схема, порт, внутренний адрес, редирект туда) — `url_invalid`.
   */
  code?: 'url_invalid' | 'site_unsupported'
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
  /**
   * Пройти по цепочке редиректов и проверить каждый шаг.
   * yt-dlp и curl следуют за редиректами сами, поэтому разрешённый хост,
   * отвечающий `302 Location: http://169.254.169.254/`, обходит проверку хоста.
   */
  checkRedirects?: boolean
}

const MAX_URL_LENGTH = 2048
const DNS_TIMEOUT_MS = 5000
const REDIRECT_TIMEOUT_MS = 5000
const MAX_REDIRECT_HOPS = 5
const REDIRECT_PROBE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

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
  // tiktok.com покрывает и короткие vm.tiktok.com / vt.tiktok.com: поддомены
  // проходят по суффиксу, а их редирект проверяет checkRedirectChain.
  'tiktok.com',
  'vk.com',
  'vk.ru',
  'vkvideo.ru',
  'rutube.ru',
] as const

/** Человекочитаемый список для сообщения об ошибке */
const SUPPORTED_PLATFORMS_TEXT = 'YouTube, Rutube, VK, TikTok, Instagram, Facebook, kino.pub'

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
  const result = await assertPublicUrlRaw(rawUrl, options)
  return result.ok || result.code ? result : { ...result, code: 'url_invalid' }
}

async function assertPublicUrlRaw(rawUrl: string, options: UrlGuardOptions): Promise<UrlGuardResult> {
  const syncCheck = checkUrlSync(rawUrl, options)
  if (!syncCheck.ok) return syncCheck

  const url = rawUrl.trim()
  const hostname = normalizeHostname(new URL(url).hostname)

  if (!isIpLiteral(hostname)) {
    const dnsCheck = await checkDnsResolvesToPublic(hostname)
    if (!dnsCheck.ok) return dnsCheck
  }

  if (options.checkRedirects) {
    return checkRedirectChain(url)
  }

  return { ok: true }
}

/**
 * Проходим цепочку редиректов сами и проверяем каждый переход.
 * Сетевые ошибки не считаем поводом для отказа: ссылку всё равно будет
 * тянуть yt-dlp, и он вернёт понятную ошибку, если хост недоступен.
 */
export async function checkRedirectChain(startUrl: string): Promise<UrlGuardResult> {
  let current = startUrl

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    const location = await peekRedirectLocation(current)
    if (!location) return { ok: true }

    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      return { ok: false, error: 'Сайт вернул некорректный редирект.', detail: `bad location ${location}` }
    }

    // Белый список к промежуточным хостам не применяем: площадки штатно
    // редиректят на свои CDN. Важно только, чтобы это не был внутренний адрес.
    const hopCheck = await assertPublicUrl(next, { enforceAllowlist: false })
    if (!hopCheck.ok) {
      return {
        ok: false,
        error: 'Ссылка перенаправляет на внутренний адрес.',
        detail: `redirect ${current} -> ${next}: ${hopCheck.detail || hopCheck.error}`,
      }
    }

    current = next
  }

  return { ok: true }
}

/** Возвращает Location, если хост ответил редиректом, иначе null. */
async function peekRedirectLocation(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': REDIRECT_PROBE_USER_AGENT },
    })

    // Тело нам не нужно — обрываем, чтобы не качать видео дважды.
    await response.body?.cancel().catch(() => {})

    if (response.status < 300 || response.status >= 400) return null
    return response.headers.get('location')
  } catch (error) {
    console.warn(`⚠️  Redirect probe failed for ${url}: ${(error as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Синхронная часть проверки — без DNS. Используется для ссылок,
 * которые мы достаём из страниц источника (манифесты kino.pub).
 */
export function isPublicUrlSync(rawUrl: string, options: UrlGuardOptions = {}): boolean {
  return checkUrlSync(rawUrl, options).ok
}

/** Проверка без сети: для мгновенного ответа API до DNS и редиректов. */
export function checkUrlSync(rawUrl: string, options: UrlGuardOptions = {}): UrlGuardResult {
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
      code: 'site_unsupported',
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
    // прокси (PROXY, YT_PROXY и др.) имя резолвит прокси, а не мы. Пропускаем —
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
