/**
 * Выходы в интернет для yt-dlp — у каждой площадки свои.
 *
 * Зачем по площадкам: YouTube отвечает адресам хостинга «Sign in to confirm
 * you're not a bot» на любое видео, и спасает только чужой выход (VPN, WARP,
 * резидентный прокси). Остальным площадкам этот выход не нужен, а гнать через
 * него видео с kino.pub значит делить канал VPN впустую.
 *
 * Значение — список через запятую, пробуется по порядку: следующий выход
 * берётся, когда предыдущий не отвечает или площадка не пускает его адрес.
 * `direct` — без прокси, с адреса сервера. Пароль с запятой кодируется как %2C.
 *
 *   YT_PROXY=http://vpn-proxy:8888,socks5://warp:1080
 *   PROXY=socks5://127.0.0.1:9050,direct
 */

export const DIRECT = 'direct'

/** Переменная на площадку; имена площадок — из профилей cookies. */
const PLATFORM_PROXY_ENV: Record<string, string> = {
  youtube: 'YT_PROXY',
  'kino.pub': 'KINOPUB_PROXY',
  instagram: 'INSTAGRAM_PROXY',
  facebook: 'FACEBOOK_PROXY',
}

type Env = Record<string, string | undefined>

/**
 * Цепочка выходов: строка — адрес прокси, null — напрямую. Всегда хотя бы
 * один элемент, поэтому индекс попытки не нужно проверять на пустоту.
 */
export function getProxyChain(platform: string | null, env: Env = process.env): Array<string | null> {
  const platformEnv = platform ? PLATFORM_PROXY_ENV[platform] : undefined
  const raw = (platformEnv && env[platformEnv]?.trim()) || env.PROXY?.trim() || ''

  const chain = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.toLowerCase() === DIRECT ? null : item))

  return chain.length > 0 ? chain : [null]
}

/** Адрес прокси для лога: логин и пароль из него не должны попасть в логи. */
export function maskProxy(proxy: string | null): string {
  if (proxy === null) return DIRECT
  return proxy.replace(/\/\/[^/@]*@/, '//***@')
}

/** Аргументы yt-dlp для лога — с замаскированным --proxy. */
export function maskProxyArgs(args: string[]): string[] {
  return args.map((arg, index) => (args[index - 1] === '--proxy' ? maskProxy(arg) : arg))
}

/**
 * Отказал сам выход, а не источник. «Unable to download» сюда не входит:
 * так yt-dlp начинает и «unable to download video data: HTTP Error 403» —
 * разовый отказ YouTube, который лечится повтором с того же выхода. Иначе
 * загрузка уходила с рабочего VPN на заблокированный адрес сервера.
 */
export function isProxyFailure(log: string): boolean {
  return /Unable to connect to proxy|ProxyError|Tunnel connection failed|SocksHTTPSConnection|Connection refused|Failed to establish a new connection|Name or service not known|Temporary failure in name resolution|timed out/i.test(log)
}
