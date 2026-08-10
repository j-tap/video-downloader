import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import crypto from 'crypto'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { formatBytes, formatDuration, limits } from './config'
import { isPublicUrlSync } from './security/urlGuard'

type Status = 'pending' | 'done' | 'error' | 'cancelled'

export interface DownloadEntry {
  id: string
  url: string
  filePath: string
  status: Status
  /** Кто запустил загрузку — только он получает статус и файл */
  clientId: string
  /** IP используется для лимитов: cookie можно сбросить, адрес — сложнее */
  ip: string
  createdAt: number
  error?: string
  progress?: number
}

export type StartDownloadResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string }

const downloads = new Map<string, DownloadEntry>()
const processes = new Map<string, ChildProcess>()
const watchdogs = new Map<string, ReturnType<typeof setInterval>>()
const timeouts = new Map<string, ReturnType<typeof setTimeout>>()

const SIZE_CHECK_INTERVAL_MS = 15_000

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp'

const DEFAULT_COOKIES_CANDIDATES = [
  process.env.COOKIES_FILE,
  path.join(process.cwd(), 'data', 'cookies.txt'),
  '/app/data/cookies.txt',
].filter(Boolean) as string[]

const YOUTUBE_COOKIES_CANDIDATES = [
  process.env.YT_COOKIES_FILE,
  path.join(process.cwd(), 'data', 'cookiesYoutube.txt'),
  '/app/data/cookiesYoutube.txt',
].filter(Boolean) as string[]

const KINOPUB_COOKIES_CANDIDATES = [
  process.env.KINOPUB_COOKIES_FILE,
  path.join(process.cwd(), 'data', 'cookiesKinoPub.txt'),
  '/app/data/cookiesKinoPub.txt',
].filter(Boolean) as string[]

const INSTAGRAM_COOKIES_CANDIDATES = [
  process.env.INSTAGRAM_COOKIES_FILE,
  path.join(process.cwd(), 'data', 'cookiesInstagram.txt'),
  '/app/data/cookiesInstagram.txt',
].filter(Boolean) as string[]

const FACEBOOK_COOKIES_CANDIDATES = [
  process.env.FACEBOOK_COOKIES_FILE,
  path.join(process.cwd(), 'data', 'cookiesFacebook.txt'),
  '/app/data/cookiesFacebook.txt',
].filter(Boolean) as string[]

export function resolveCookiesFile(url?: string): string | null {
  for (const candidate of getCookiesCandidates(url)) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(process.cwd(), candidate)

    if (fs.existsSync(resolved)) {
      return resolved
    }
  }

  return null
}

export function getCookiesConfig(): {
  file: string | null
  fromBrowser: string | null
  configured: boolean
} {
  const fromBrowser = process.env.COOKIES_FROM_BROWSER?.trim()
    || process.env.YT_COOKIES_FROM_BROWSER?.trim()
    || process.env.KINOPUB_COOKIES_FROM_BROWSER?.trim()
    || process.env.INSTAGRAM_COOKIES_FROM_BROWSER?.trim()
    || process.env.FACEBOOK_COOKIES_FROM_BROWSER?.trim()
    || null
  const file = resolveCookiesFile()

  return {
    file,
    fromBrowser,
    configured: Boolean(file || fromBrowser),
  }
}

/**
 * Запись отдаётся только владельцу: id — это capability-токен,
 * но привязка к клиенту закрывает и подбор, и утечку id через логи/реферер.
 */
export function getDownloadStatus(id: string, clientId: string): DownloadEntry | undefined {
  const entry = downloads.get(id)
  if (!entry || entry.clientId !== clientId) return undefined
  return entry
}

export function verifyYtDlp(): { ok: boolean; version?: string; error?: string; ageDays?: number } {
  const result = spawnSync(YTDLP_BIN, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || 'yt-dlp not found' }
  }

  const version = result.stdout?.trim()
  return { ok: true, version, ageDays: getYtDlpAgeDays(version) }
}

/**
 * Версия yt-dlp — это дата релиза (2026.07.04). Устаревший бинарник
 * в собранном образе — самая частая причина «часть видео не скачивается»:
 * экстракторы ломаются вслед за изменениями на стороне YouTube.
 */
function getYtDlpAgeDays(version?: string): number | undefined {
  const match = version?.match(/^(\d{4})\.(\d{2})\.(\d{2})/)
  if (!match) return undefined

  const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Math.floor((Date.now() - released) / 86_400_000)
}

export interface DownloadOwner {
  clientId: string
  ip: string
}

export function startDownload(url: string, owner: DownloadOwner): StartDownloadResult {
  const rejection = checkCapacity(owner.ip)
  if (rejection) return rejection

  const id = generateId()
  const filePath = getTempFilePath(id)

  const entry: DownloadEntry = {
    id,
    url,
    filePath,
    status: 'pending',
    clientId: owner.clientId,
    ip: owner.ip,
    createdAt: Date.now(),
  }
  downloads.set(id, entry)

  armDownloadTimeout(id)
  startSizeWatchdog(id)

  runDownloadProcess(normalizeUrl(url), filePath, id)

  return { ok: true, id }
}

/** Возвращает причину отказа или null, если можно стартовать. */
function checkCapacity(ip: string): Extract<StartDownloadResult, { ok: false }> | null {
  const active = [...downloads.values()].filter((entry) => entry.status === 'pending')

  if (active.length >= limits.maxConcurrentDownloads) {
    return {
      ok: false,
      status: 503,
      error: 'Сервер сейчас занят другими загрузками. Попробуйте через несколько минут.',
    }
  }

  const activeForClient = active.filter((entry) => entry.ip === ip).length
  if (activeForClient >= limits.maxConcurrentPerClient) {
    return {
      ok: false,
      status: 429,
      error: 'У вас уже идёт загрузка. Дождитесь её завершения или отмените.',
    }
  }

  if (getUsedStorageBytes() >= limits.maxTotalStorageBytes) {
    return {
      ok: false,
      status: 503,
      error: 'На сервере закончилось место для временных файлов. Попробуйте позже.',
    }
  }

  return null
}

/**
 * Суммарный объём наших временных файлов (включая недокачанные .part
 * и осиротевшие после перезапуска) — одним чтением каталога.
 */
function getUsedStorageBytes(): number {
  const dir = tmpdir()

  try {
    return fs.readdirSync(dir)
      .filter((name) => matchOwnTempFile(name) !== null)
      .reduce((sum, name) => {
        try {
          return sum + fs.statSync(path.join(dir, name)).size
        } catch {
          return sum
        }
      }, 0)
  } catch {
    return 0
  }
}

/**
 * После падения или рестарта в tmp остаются файлы, которые никто уже не заберёт.
 * Без этой уборки они бессрочно занимают место и съедают квоту.
 */
export function cleanupOrphanedFiles(): number {
  const dir = tmpdir()
  let removed = 0

  try {
    for (const name of fs.readdirSync(dir)) {
      const id = matchOwnTempFile(name)
      if (!id || downloads.has(id)) continue

      try {
        fs.unlinkSync(path.join(dir, name))
        removed += 1
      } catch {
        // файл могли удалить параллельно — не мешает
      }
    }
  } catch {
    return removed
  }

  return removed
}

/**
 * Наши файлы называются строго `video-<uuid>...` и `cookies-<uuid>.txt`.
 * Проверка по UUID нужна, чтобы не тронуть чужое в общем /tmp.
 */
const OWN_TEMP_FILE = /^(?:video|cookies)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.|$)/i

function matchOwnTempFile(name: string): string | null {
  return name.match(OWN_TEMP_FILE)?.[1] ?? null
}

/** Размер всех файлов, которые yt-dlp создал под этот id (mp4, .part, .f137.mp4 и т.д.). */
function getDownloadBytes(id: string, filePath: string): number {
  const dir = path.dirname(filePath)
  const prefix = `video-${id}`

  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .reduce((sum, name) => {
        try {
          return sum + fs.statSync(path.join(dir, name)).size
        } catch {
          return sum
        }
      }, 0)
  } catch {
    return 0
  }
}

/**
 * --max-filesize не работает для HLS/фрагментированных потоков,
 * поэтому размер контролируем сами и убиваем процесс при превышении.
 */
function startSizeWatchdog(id: string): void {
  const timer = setInterval(() => {
    const entry = downloads.get(id)
    if (!entry || entry.status !== 'pending') {
      stopSizeWatchdog(id)
      return
    }

    const bytes = getDownloadBytes(id, entry.filePath)
    if (bytes > limits.maxDownloadBytes) {
      console.warn(`⚠️  [${id}] Size limit exceeded (${formatBytes(bytes)}), killing process`)
      abortDownload(id, `Файл превышает лимит ${formatBytes(limits.maxDownloadBytes)}.`)
    }
  }, SIZE_CHECK_INTERVAL_MS)

  timer.unref?.()
  watchdogs.set(id, timer)
}

function stopSizeWatchdog(id: string): void {
  const timer = watchdogs.get(id)
  if (timer) clearInterval(timer)
  watchdogs.delete(id)
}

function armDownloadTimeout(id: string): void {
  const timer = setTimeout(() => {
    const entry = downloads.get(id)
    if (!entry || entry.status !== 'pending') return

    console.warn(`⚠️  [${id}] Download timed out after ${limits.downloadTimeoutMs / 60_000} min`)
    abortDownload(id, 'Превышено время загрузки. Попробуйте ссылку на видео покороче.')
  }, limits.downloadTimeoutMs)

  timer.unref?.()
  timeouts.set(id, timer)
}

function clearDownloadTimeout(id: string): void {
  const timer = timeouts.get(id)
  if (timer) clearTimeout(timer)
  timeouts.delete(id)
}

/** Принудительное завершение загрузки сервером (лимит размера/времени). */
function abortDownload(id: string, message: string): void {
  const entry = downloads.get(id)
  if (!entry) return

  killProcess(id)

  entry.status = 'error'
  entry.error = message

  cleanupDownloadArtifacts(id)
  scheduleEntryRemoval(id)
}

function killProcess(id: string): void {
  const child = processes.get(id)
  if (child && !child.killed) {
    child.kill('SIGTERM')
    // Если yt-dlp не завершился по SIGTERM (например, висит ffmpeg) — добиваем.
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 5000)
    killTimer.unref?.()
  }
}

export function cancelDownload(id: string, clientId: string): boolean {
  const entry = downloads.get(id)
  if (!entry || entry.clientId !== clientId || entry.status !== 'pending') return false

  entry.status = 'cancelled'
  console.log(`⏹️  [${id}] Download cancelled`)

  killProcess(id)

  cleanupDownloadArtifacts(id)
  scheduleEntryRemoval(id)
  return true
}

function scheduleEntryRemoval(id: string, delayMs = 60_000): void {
  const timer = setTimeout(() => downloads.delete(id), delayMs)
  timer.unref?.()
}

function generateId(): string {
  return crypto.randomUUID()
}

function getTempFilePath(id: string): string {
  return path.join(tmpdir(), `video-${id}.mp4`)
}

function normalizeUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  if (isYouTube(parsed.href)) {
    return normalizeYouTubeUrl(parsed)
  }

  if (isInstagram(parsed.href) || isFacebook(parsed.href)) {
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  }

  return parsed.toString()
}

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

/**
 * Приводим все формы ссылки к /watch?v=ID и отбрасываем трекинг.
 * Строковая замена по подстроке этого не умела: `youtu.be/ID?si=xxx`
 * превращался в `watch?v=ID?si=xxx`.
 */
function normalizeYouTubeUrl(parsed: URL): string {
  const videoId = extractYouTubeId(parsed)
  if (!videoId) return parsed.toString()

  return `https://www.youtube.com/watch?v=${videoId}`
}

function extractYouTubeId(parsed: URL): string | null {
  const segments = parsed.pathname.split('/').filter(Boolean)

  // youtu.be/<id>
  if (parsed.hostname.toLowerCase().endsWith('youtu.be')) {
    return matchYouTubeId(segments[0])
  }

  // /shorts/<id>, /live/<id>, /embed/<id>, /v/<id>
  if (segments.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(segments[0] || '')) {
    return matchYouTubeId(segments[1])
  }

  return matchYouTubeId(parsed.searchParams.get('v') || undefined)
}

function matchYouTubeId(value?: string): string | null {
  return value && YOUTUBE_ID_PATTERN.test(value) ? value : null
}

function runDownloadProcess(url: string, filePath: string, id: string): void {
  const target = resolveDownloadTarget(url, id)
  if (target.trailerOnly) {
    const entry = downloads.get(id)
    if (entry) {
      failDownload(id, entry, 'kino.pub returned only trailer stream for this page')
    }
    cleanupDownloadArtifacts(id)
    return
  }

  console.log(`▶️  [${id}] Starting download: ${target.url}`)
  if (target.playlistItemIndex) {
    console.log(`ℹ️  [${id}] kino.pub selected playlist item: ${target.playlistItemIndex}`)
  }

  const args = buildYtDlpArgs(target.url, filePath, id, { attempt: 0, playlistItemIndex: target.playlistItemIndex })
  runYtDlpProcess(args, id, filePath, { url: target.url, filePath, attempt: 0, useProxy: true, playlistItemIndex: target.playlistItemIndex })
}

interface BuildOptions {
  attempt?: number
  useProxy?: boolean
  playlistItemIndex?: number | null
}

function buildYtDlpArgs(url: string, filePath: string, id: string, options: BuildOptions = {}): string[] {
  const { attempt = 0, useProxy = true, playlistItemIndex = null } = options
  const args = [
    ...getPlaylistArgs(url, playlistItemIndex),
    '--no-warnings',
    '--newline',
    '--socket-timeout', '30',
    '--retries', '5',
    '--fragment-retries', '5',
    ...getLimitArgs(),
    ...getJsRuntimeArgs(),
    ...getProxyArgs(useProxy),
    ...getCookiesArgs(id, url),
    ...getPlatformArgs(url, attempt),
    '-o', filePath,
    url,
  ]

  return args
}

/**
 * Лимиты на стороне yt-dlp. Работают не для всех источников
 * (например --max-filesize неизвестен для HLS), поэтому дублируются watchdog-ом.
 */
function getLimitArgs(): string[] {
  return [
    '--max-filesize', String(limits.maxDownloadBytes),
    // `<?` — пропускать, если поле отсутствует (часто у прямых m3u8)
    '--match-filter', `duration<?${limits.maxDurationSeconds}`,
  ]
}

function getPlaylistArgs(url: string, playlistItemIndex: number | null): string[] {
  if (!isKinoPub(url)) {
    return ['--no-playlist']
  }

  if (playlistItemIndex) {
    return [
      '--yes-playlist',
      '--ignore-errors',
      '--playlist-items', String(playlistItemIndex),
    ]
  }

  return [
    '--yes-playlist',
    '--ignore-errors',
    '--reject-title', '(?i)(trailer|preview|тизер|трейлер)',
    '--max-downloads', '1',
  ]
}

interface YtDlpProbeEntry {
  title?: string
  description?: string
  id?: string
  duration?: number
  webpage_url?: string
  url?: string
}

interface ResolvedDownloadTarget {
  url: string
  playlistItemIndex: number | null
  trailerOnly: boolean
}

interface KinoPubPlaylistItem {
  manifest?: string
  season?: number
  episode?: number
}

function resolveDownloadTarget(url: string, id: string): ResolvedDownloadTarget {
  if (!isKinoPub(url)) {
    return { url, playlistItemIndex: null, trailerOnly: false }
  }

  const manifestFromPage = resolveKinoPubManifestFromPage(url, id)
  if (manifestFromPage && !isPublicUrlSync(manifestFromPage)) {
    console.warn(`⛔ [${id}] Manifest URL from page rejected: ${manifestFromPage}`)
  } else if (manifestFromPage) {
    console.log(`ℹ️  [${id}] kino.pub selected manifest from PLAYER_PLAYLIST`)
    return { url: manifestFromPage, playlistItemIndex: null, trailerOnly: false }
  }

  const selected = resolveKinoPubMainEntry(url, id)
  if (!selected) {
    return { url, playlistItemIndex: null, trailerOnly: false }
  }

  return selected
}

function resolveKinoPubMainEntry(url: string, id: string): ResolvedDownloadTarget | null {
  const probeArgs = [
    '--dump-single-json',
    '--skip-download',
    '--yes-playlist',
    '--no-warnings',
    ...getJsRuntimeArgs(),
    ...getProxyArgs(true),
    ...getCookiesArgs(id, url),
    url,
  ]

  const probe = spawnSync(YTDLP_BIN, probeArgs, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (probe.status !== 0 || !probe.stdout?.trim()) {
    console.warn(`⚠️  [${id}] kino.pub preflight failed, using original URL`)
    return null
  }

  const json = tryParseJson(probe.stdout)
  if (!json || typeof json !== 'object') {
    return null
  }

  const entries = Array.isArray((json as { entries?: unknown }).entries)
    ? ((json as { entries: unknown[] }).entries as YtDlpProbeEntry[])
    : []

  if (entries.length === 0) {
    const formats = Array.isArray((json as { formats?: unknown }).formats)
      ? ((json as { formats: unknown[] }).formats as Array<{ url?: string; manifest_url?: string }>)
      : []

    const urls = formats
      .flatMap((format) => [format.url, format.manifest_url])
      .filter(Boolean) as string[]

    const hasTrailerOnly = urls.length > 0 && urls.every((candidateUrl) => isTrailerStreamUrl(candidateUrl))
    if (hasTrailerOnly) {
      return { url, playlistItemIndex: null, trailerOnly: true }
    }

    return null
  }

  const entriesWithIndex = entries.map((entry, index) => ({ entry, index: index + 1 }))
  const nonTrailer = entriesWithIndex.filter(({ entry }) => !isTrailerEntry(entry))
  const pool = nonTrailer.length > 0 ? nonTrailer : entriesWithIndex
  const withDuration = pool.filter(({ entry }) => typeof entry.duration === 'number' && entry.duration > 0)

  const sorted = (withDuration.length > 0 ? withDuration : pool)
    .slice()
    .sort((a, b) => (b.entry.duration || 0) - (a.entry.duration || 0))

  const selected = sorted[0]
  if (!selected) return null

  return {
    url,
    playlistItemIndex: selected.index,
    trailerOnly: false,
  }
}

function resolveKinoPubManifestFromPage(url: string, id: string): string | null {
  const html = fetchKinoPubPageHtml(url, id)
  if (!html) return null

  const playlist = extractPlayerPlaylist(html)
  if (playlist.length === 0) return null

  const pageEpisode = parseSeasonEpisodeFromUrl(url)
  if (pageEpisode) {
    const exact = playlist.find((item) => item.season === pageEpisode.season && item.episode === pageEpisode.episode)
    if (exact?.manifest && !isTrailerStreamUrl(exact.manifest)) {
      return exact.manifest
    }
  }

  const startIndex = extractPlayerStartIndex(html)
  if (startIndex !== null) {
    const byStartIndex = playlist[startIndex]
    if (byStartIndex?.manifest && !isTrailerStreamUrl(byStartIndex.manifest)) {
      return byStartIndex.manifest
    }
  }

  const firstNonTrailer = playlist.find((item) => item.manifest && !isTrailerStreamUrl(item.manifest))
  return firstNonTrailer?.manifest || null
}

function fetchKinoPubPageHtml(url: string, id: string): string | null {
  const cookiesFile = resolveCookiesFile(url)
  if (!cookiesFile) {
    console.warn(`⚠️  [${id}] kino.pub page parse skipped: cookies file not found`)
    return null
  }

  const curlArgs = [
    '-fsSL',
    // Ограничиваем, куда и как долго может уйти запрос со страницы
    '--proto', '=http,https',
    '--proto-redir', '=http,https',
    '--max-redirs', '3',
    '--max-time', '25',
    '--max-filesize', '10485760',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    '-e', 'https://kino.pub/',
    '-b', cookiesFile,
    url,
  ]

  const result = spawnSync('curl', curlArgs, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.status !== 0 || !result.stdout?.trim()) {
    console.warn(`⚠️  [${id}] kino.pub page parse failed, fallback to extractor preflight`)
    return null
  }

  return result.stdout
}

function extractPlayerPlaylist(html: string): KinoPubPlaylistItem[] {
  const match = html.match(/window\.PLAYER_PLAYLIST\s*=\s*(\[[\s\S]*?\]);/)
  if (!match?.[1]) return []

  const parsed = tryParseJson(match[1])
  if (!Array.isArray(parsed)) return []
  return parsed as KinoPubPlaylistItem[]
}

function extractPlayerStartIndex(html: string): number | null {
  const match = html.match(/window\.PLAYER_START_INDEX\s*=\s*(\d+)\s*;/)
  if (!match?.[1]) return null

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseSeasonEpisodeFromUrl(url: string): { season: number; episode: number } | null {
  const match = url.match(/\/s(\d+)e(\d+)/i)
  if (!match?.[1] || !match[2]) return null

  const season = Number.parseInt(match[1], 10)
  const episode = Number.parseInt(match[2], 10)
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null

  return { season, episode }
}

function isTrailerEntry(entry: YtDlpProbeEntry): boolean {
  const marker = `${entry.title || ''} ${entry.description || ''} ${entry.id || ''} ${entry.url || ''} ${entry.webpage_url || ''}`.toLowerCase()
  return /(trailer|preview|тизер|трейлер|анонс)/i.test(marker)
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function getJsRuntimeArgs(): string[] {
  if (process.env.YTDLP_JS_RUNTIMES) {
    return ['--js-runtimes', process.env.YTDLP_JS_RUNTIMES]
  }

  const bunPath = process.env.BUN_INSTALL
    ? path.join(process.env.BUN_INSTALL, 'bin', 'bun')
    : process.execPath.includes('bun') ? process.execPath : null

  if (bunPath && fs.existsSync(bunPath)) {
    return ['--js-runtimes', `bun:${bunPath}`]
  }

  const denoPath = process.env.DENO_INSTALL
    ? path.join(process.env.DENO_INSTALL, 'bin', 'deno')
    : '/usr/local/bin/deno'

  if (fs.existsSync(denoPath)) {
    return ['--js-runtimes', `deno:${denoPath}`]
  }

  return []
}

function getProxyArgs(useProxy = true): string[] {
  if (!useProxy) return []
  const proxy = process.env.YT_PROXY || process.env.PROXY
  return proxy ? ['--proxy', proxy] : []
}

function getTempCookiesPath(id: string): string {
  return path.join(tmpdir(), `cookies-${id}.txt`)
}

function getCookiesArgs(id: string, url: string): string[] {
  const fromBrowser = getCookiesFromBrowser(url)
  if (fromBrowser) {
    return ['--cookies-from-browser', fromBrowser]
  }

  const cookiesFile = resolveCookiesFile(url)
  if (!cookiesFile) return []

  const tmpCookies = getTempCookiesPath(id)
  fs.copyFileSync(cookiesFile, tmpCookies)
  return ['--cookies', tmpCookies]
}

function cleanupTempCookies(id: string): void {
  fs.unlink(getTempCookiesPath(id), () => {})
}

function getCookiesCandidates(url?: string): string[] {
  if (!url) {
    return [
      ...DEFAULT_COOKIES_CANDIDATES,
      ...YOUTUBE_COOKIES_CANDIDATES,
      ...KINOPUB_COOKIES_CANDIDATES,
      ...INSTAGRAM_COOKIES_CANDIDATES,
      ...FACEBOOK_COOKIES_CANDIDATES,
    ]
  }

  if (isYouTube(url)) {
    return [...YOUTUBE_COOKIES_CANDIDATES, ...DEFAULT_COOKIES_CANDIDATES]
  }

  if (isKinoPubRelated(url)) {
    return [...KINOPUB_COOKIES_CANDIDATES, ...DEFAULT_COOKIES_CANDIDATES]
  }

  if (isInstagram(url)) {
    return [...INSTAGRAM_COOKIES_CANDIDATES, ...DEFAULT_COOKIES_CANDIDATES]
  }

  if (isFacebook(url)) {
    return [...FACEBOOK_COOKIES_CANDIDATES, ...DEFAULT_COOKIES_CANDIDATES]
  }

  return DEFAULT_COOKIES_CANDIDATES
}

function getCookiesFromBrowser(url: string): string | null {
  if (isYouTube(url)) {
    return process.env.YT_COOKIES_FROM_BROWSER?.trim() || process.env.COOKIES_FROM_BROWSER?.trim() || null
  }

  if (isKinoPubRelated(url)) {
    return process.env.KINOPUB_COOKIES_FROM_BROWSER?.trim() || process.env.COOKIES_FROM_BROWSER?.trim() || null
  }

  if (isInstagram(url)) {
    return process.env.INSTAGRAM_COOKIES_FROM_BROWSER?.trim() || process.env.COOKIES_FROM_BROWSER?.trim() || null
  }

  if (isFacebook(url)) {
    return process.env.FACEBOOK_COOKIES_FROM_BROWSER?.trim() || process.env.COOKIES_FROM_BROWSER?.trim() || null
  }

  return process.env.COOKIES_FROM_BROWSER?.trim() || null
}

function cleanupDownloadArtifacts(id: string): void {
  cleanupTempCookies(id)
  stopSizeWatchdog(id)
  clearDownloadTimeout(id)
  processes.delete(id)

  const entry = downloads.get(id)
  if (!entry) return

  removeDownloadFiles(id, entry.filePath)
}

/** Удаляем все файлы, созданные под этот id, включая .part и промежуточные форматы. */
function removeDownloadFiles(id: string, filePath: string): void {
  const dir = path.dirname(filePath)
  const prefix = `video-${id}`

  fs.readdir(dir, (error, names) => {
    if (error) return
    for (const name of names) {
      if (name.startsWith(prefix)) {
        fs.unlink(path.join(dir, name), () => {})
      }
    }
  })
}

function isCancelled(id: string): boolean {
  const entry = downloads.get(id)
  return entry?.status === 'cancelled'
}

function isYouTube(url: string): boolean {
  return hasMatchingHostname(url, ['youtube.com', 'youtu.be'])
}

function isFacebook(url: string): boolean {
  return hasMatchingHostname(url, ['facebook.com', 'fb.com', 'fb.watch'])
}

function isInstagram(url: string): boolean {
  return hasMatchingHostname(url, ['instagram.com', 'instagr.am'])
}

function isKinoPub(url: string): boolean {
  return hasMatchingHostname(url, ['kino.pub'])
}

function hasMatchingHostname(url: string, hosts: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

function isKinoPubRelated(url: string): boolean {
  return isKinoPub(url) || hasMatchingHostname(url, ['cdntogo.net'])
}

function isTrailerStreamUrl(url: string): boolean {
  return /\/trailers?\//i.test(url)
}

function getKinoPubHeaderArgs(): string[] {
  return [
    '--add-header', 'Referer:https://kino.pub/',
    '--add-header', 'Origin:https://kino.pub',
  ]
}

function getPlatformArgs(url: string, attempt: number): string[] {
  if (isYouTube(url)) {
    return getYouTubeArgs(attempt)
  }

  if (isKinoPubRelated(url)) {
    return [
      '-f', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      ...getKinoPubHeaderArgs(),
      '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    ]
  }

  if (isFacebook(url) || isInstagram(url)) {
    return [
      '-f', 'bv*+ba/b',
      '--recode-video', 'mp4',
      '--postprocessor-args', 'ffmpeg:-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart',
    ]
  }

  return [
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
  ]
}

function getYouTubeArgs(attempt: number): string[] {
  const args: string[] = [
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
  ]

  const poToken = process.env.YT_PO_TOKEN
  if (poToken) {
    args.push('--extractor-args', `youtube:po_token=${poToken}`)
  }

  const playerClient = getYouTubePlayerClient(attempt)
  if (playerClient) {
    args.push('--extractor-args', `youtube:player_client=${playerClient}`)
  }

  return args
}

function getYouTubePlayerClient(attempt: number): string | null {
  if (process.env.YT_PLAYER_CLIENT) {
    return process.env.YT_PLAYER_CLIENT
  }

  const hasCookies = getCookiesConfig().configured

  // Первая попытка — без переопределения: набор клиентов по умолчанию
  // в yt-dlp обновляется вместе с изменениями YouTube и работает лучше всего.
  // Клиент `android` сюда не входит намеренно: он молча отдаёт только 360p.
  const fallbacks: Array<string | null> = hasCookies
    ? [null, 'android_vr,mweb', 'web,web_safari']
    : [null, 'android_vr,mweb,web_safari', 'tv_simply,ios']

  const index = Math.min(Math.max(attempt, 0), fallbacks.length - 1)

  // Важно: именно индексный доступ, а не `??` по значению —
  // null на первой попытке означает "не переопределять", а не "нет значения".
  return fallbacks[index] ?? null
}

interface RunContext {
  url: string
  filePath: string
  attempt: number
  useProxy: boolean
  playlistItemIndex: number | null
}

function runYtDlpProcess(
  args: string[],
  id: string,
  filePath: string,
  ctx: RunContext,
): void {
  console.log(`▶️ yt-dlp [attempt ${ctx.attempt}]:`, args.join(' '))

  const child = spawn(YTDLP_BIN, args)
  processes.set(id, child)
  const stderrChunks: string[] = []
  // yt-dlp сообщает о срабатывании --max-filesize/--match-filter в stdout
  // и завершается с кодом 0, поэтому такие строки собираем отдельно.
  const noticeChunks: string[] = []

  const handleOutput = (message: string) => {
    if (isCancelled(id)) return

    const progress = parseProgress(message)
    if (progress !== null) {
      const entry = downloads.get(id)
      if (entry) entry.progress = progress
    }
  }

  child.stdout.on('data', (data) => {
    const message = data.toString()
    console.log(`yt-dlp stdout [${id}]:`, message)
    if (/larger than max-filesize|does not pass filter/i.test(message)) {
      noticeChunks.push(message)
    }
    handleOutput(message)
  })

  child.stderr.on('data', (data) => {
    const message = data.toString()
    stderrChunks.push(message)
    console.error(`yt-dlp stderr [${id}]:`, message)
    handleOutput(message)
  })

  child.on('close', (code) => {
    processes.delete(id)

    const entry = downloads.get(id)
    if (!entry) return

    if (isCancelled(id)) return

    const logSummary = stderrChunks.join('').trim()

    // Некоторые экстракторы возвращают ненулевой код из-за побочных ошибок плейлиста,
    // хотя нужный файл уже скачан корректно — поэтому сначала проверяем файл.
    const verified = verifyDownloadedFile(id, filePath, entry)

    if (verified.ok) {
      if (code !== 0) {
        console.warn(`⚠️  [${id}] yt-dlp exited with code ${code}, but file is valid. Marking as done.`)
      }
      entry.status = 'done'
      scheduleCleanup(entry)
      cleanupTempCookies(id)
      stopSizeWatchdog(id)
      clearDownloadTimeout(id)
      return
    }

    // Ретрай не должен переводить запись в error — иначе клиент увидит ошибку
    // и перестанет опрашивать статус, пока следующая попытка ещё идёт.
    if (tryRetry(id, filePath, entry, logSummary, ctx)) return

    const notice = noticeChunks.join('').trim()
    failDownload(id, entry, logSummary || notice || verified.reason, code ?? undefined)
    cleanupDownloadArtifacts(id)
    scheduleEntryRemoval(id, 5 * 60_000)
  })
}

interface VerifyResult {
  ok: boolean
  reason: string
}

function verifyDownloadedFile(id: string, filePath: string, entry: DownloadEntry): VerifyResult {
  const resolvedFilePath = resolveDownloadedFilePath(filePath)
  if (!resolvedFilePath) {
    return { ok: false, reason: 'File not found after download' }
  }

  if (resolvedFilePath !== entry.filePath) {
    console.log(`ℹ️  [${id}] Resolved output file: ${resolvedFilePath}`)
    entry.filePath = resolvedFilePath
  }

  try {
    const stats = fs.statSync(entry.filePath)
    if (stats.size === 0) {
      return { ok: false, reason: 'Downloaded file is empty' }
    }
    console.log(`✅  [${id}] Download complete (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
    return { ok: true, reason: '' }
  } catch (error) {
    return { ok: false, reason: `Unable to read downloaded file: ${(error as Error).message}` }
  }
}

function resolveDownloadedFilePath(expectedPath: string): string | null {
  if (fs.existsSync(expectedPath)) {
    return expectedPath
  }

  const dir = path.dirname(expectedPath)
  const baseName = path.basename(expectedPath, path.extname(expectedPath))

  try {
    const candidates = fs.readdirSync(dir)
      .filter((name) => name.startsWith(baseName))
      .filter((name) => !name.endsWith('.part'))
      .filter((name) => !name.endsWith('.ytdl'))
      // video-<id>.f137.mp4 — это отдельная дорожка до merge.
      // Без этого фильтра после неудачной попытки можно отдать
      // пользователю файл только со звуком или только с видео.
      .filter((name) => !/\.f\d+\./.test(name))
      .map((name) => path.join(dir, name))
      .filter((candidatePath) => {
        try {
          return fs.statSync(candidatePath).isFile()
        } catch {
          return false
        }
      })

    if (candidates.length === 0) {
      return null
    }

    candidates.sort((a, b) => {
      const aStat = fs.statSync(a)
      const bStat = fs.statSync(b)
      if (aStat.size !== bStat.size) {
        return bStat.size - aStat.size
      }
      return bStat.mtimeMs - aStat.mtimeMs
    })

    return candidates[0] || null
  } catch {
    return null
  }
}

function tryRetry(
  id: string,
  filePath: string,
  entry: DownloadEntry,
  logSummary: string,
  ctx: RunContext,
): boolean {
  if (isCancelled(id)) return false

  const hasProxy = ctx.useProxy && (process.env.YT_PROXY || process.env.PROXY) !== undefined
  const isProxyError = /timed out|proxy|Connection refused|SocksHTTPSConnection|Unable to download|Failed to establish/i.test(logSummary)
  const isYouTubeError = isYouTube(entry.url) && /PO Token|reloaded|403|Sign in|age.restricted|format.*not available/i.test(logSummary)

  if (hasProxy && isProxyError) {
    console.log(`⚠️  [${id}] Proxy error, retrying without proxy...`)
    const retryArgs = buildYtDlpArgs(ctx.url, filePath, id, {
      attempt: ctx.attempt,
      useProxy: false,
      playlistItemIndex: ctx.playlistItemIndex,
    })
    runYtDlpProcess(retryArgs, id, filePath, { ...ctx, useProxy: false })
    return true
  }

  if (isYouTubeError && ctx.attempt < 2 && !process.env.YT_PLAYER_CLIENT) {
    const nextAttempt = ctx.attempt + 1
    console.log(`⚠️  [${id}] YouTube error, retrying with fallback player_client (attempt ${nextAttempt})...`)
    const retryArgs = buildYtDlpArgs(ctx.url, filePath, id, {
      attempt: nextAttempt,
      useProxy: ctx.useProxy,
      playlistItemIndex: ctx.playlistItemIndex,
    })
    runYtDlpProcess(retryArgs, id, filePath, { ...ctx, attempt: nextAttempt })
    return true
  }

  return false
}

function scheduleCleanup(entry: DownloadEntry): void {
  const timer = setTimeout(() => {
    removeDownloadFiles(entry.id, entry.filePath)
    downloads.delete(entry.id)
  }, limits.fileTtlMs)

  timer.unref?.()
}

function parseProgress(message: string): number | null {
  const percentMatch = message.match(/\[download\]\s+(\d+\.?\d*)%/)
  if (!percentMatch?.[1]) return null
  const percent = parseFloat(percentMatch[1])
  return Math.min(100, Math.max(0, percent))
}

function failDownload(id: string, entry: DownloadEntry, logSummary: string, code?: number): void {
  const detail = cleanErrorMessage(logSummary) || (code !== undefined ? `yt-dlp exited with code ${code}` : logSummary)
  console.error(`❌  [${id}] Download failed: ${detail}`)
  if (logSummary && logSummary !== detail) {
    console.error(`❌  [${id}] Full log:\n${logSummary}`)
  }
  entry.status = 'error'
  entry.error = getPublicErrorMessage(detail, entry.url)
}

function getPublicErrorMessage(detail: string, url: string): string {
  if (/larger than max-filesize/i.test(detail)) {
    return `Видео больше лимита ${formatBytes(limits.maxDownloadBytes)}.`
  }

  if (/does not pass filter/i.test(detail)) {
    return `Видео длиннее лимита в ${formatDuration(limits.maxDurationSeconds)}.`
  }

  if (/only trailer stream/i.test(detail)) {
    return 'Для этой страницы kino.pub доступен только трейлер. Вставьте прямую ссылку на full m3u8 из Network.'
  }

  if (isKinoPubRelated(url) && /authoriz|login|sign in|403|forbidden|unauthorized|access denied|cookies/i.test(detail)) {
    const hasCookies = Boolean(getCookiesFromBrowser(url) || resolveCookiesFile(url))
    if (!hasCookies) {
      return 'kino.pub требует авторизацию: добавьте KINOPUB_COOKIES_FILE (data/cookiesKinoPub.txt) или KINOPUB_COOKIES_FROM_BROWSER.'
    }
    return 'kino.pub не принял cookies: обновите cookiesKinoPub.txt (экспорт из браузера с активной сессией).'
  }

  if (isInstagram(url) && /login|sign in|cookies|private|403|forbidden|unauthorized/i.test(detail)) {
    return 'Instagram требует авторизацию: укажите INSTAGRAM_COOKIES_FILE или INSTAGRAM_COOKIES_FROM_BROWSER.'
  }

  if (isFacebook(url) && /login|sign in|cookies|private|403|forbidden|unauthorized/i.test(detail)) {
    return 'Facebook требует авторизацию: укажите FACEBOOK_COOKIES_FILE или FACEBOOK_COOKIES_FROM_BROWSER.'
  }

  if (/Sign in to confirm/i.test(detail)) {
    return 'Требуется авторизация для источника.'
  }

  if (/Connection refused|SocksHTTPSConnection|proxy|timed out|Failed to establish/i.test(detail)) {
    return 'Ошибка сети или прокси.'
  }

  if (/DRM|Widevine|protected content|copyright protection/i.test(detail)) {
    return 'Видео защищено DRM и не может быть скачано.'
  }

  if (/Postprocessing|ffmpeg|Conversion failed|Error opening output files|Invalid data found/i.test(detail)) {
    return 'Ошибка обработки видео (ffmpeg/postprocessing). Проверьте исходный поток и попробуйте снова.'
  }

  if (/Unsupported URL|No video formats found|404|not found/i.test(detail)) {
    return 'Видео не найдено или ссылка не поддерживается.'
  }

  if (/File not found after download|Unable to read downloaded file|Downloaded file is empty/i.test(detail)) {
    return 'Источник отдал некорректный файл. Повторите попытку или обновите cookies.'
  }

  if (/age.restricted/i.test(detail)) {
    return 'Контент недоступен без авторизации.'
  }

  const normalized = detail
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized) {
    return `Ошибка загрузки: ${normalized.slice(0, 220)}`
  }

  return 'Ошибка загрузки.'
}

function cleanErrorMessage(error: string): string {
  if (error.includes('Connection refused') && error.includes('SocksHTTPSConnection')) {
    return 'Ошибка подключения к прокси. Проверьте YT_PROXY или отключите прокси.'
  }

  if (/Sign in to confirm/i.test(error)) {
    const cookies = getCookiesConfig()
    if (!cookies.configured) {
      return 'YouTube требует авторизацию. Укажите YT_COOKIES_FILE (файл Netscape в data/cookiesYoutube.txt) или YT_COOKIES_FROM_BROWSER.'
    }
    return 'YouTube не принял cookies: обновите cookiesYoutube.txt (экспорт из браузера, где YouTube открывается без капчи) или проверьте IP сервера.'
  }

  const lines = error.split('\n')
  const importantLines: string[] = []

  for (const line of lines) {
    if (line.includes('yt-dlp version') && line.includes('older than')) continue
    if (line.includes('Retrying')) continue
    if (line.includes('SocksHTTPSConnection') && line.includes('object at')) continue
    if (line.includes('ERROR:') ||
        (line.includes('WARNING:') && /Unable to download|timed out|Failed to extract|PO Token|reloaded|Postprocessing|ffmpeg|Conversion failed/i.test(line)) ||
        /Conversion failed|Postprocessing|Error opening output files|Invalid data found/i.test(line)) {
      importantLines.push(line)
    }
  }

  if (importantLines.length > 0) {
    return importantLines.join(' ').trim()
  }

  const errorLine = lines.find(line => line.includes('ERROR:'))
  return errorLine?.trim() || error.trim()
}
