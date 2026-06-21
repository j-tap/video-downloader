import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import crypto from 'crypto'
import { spawn, spawnSync, type ChildProcess } from 'child_process'

type Status = 'pending' | 'done' | 'error' | 'cancelled'

export interface DownloadEntry {
  id: string
  url: string
  filePath: string
  status: Status
  error?: string
  progress?: number
}

const downloads = new Map<string, DownloadEntry>()
const processes = new Map<string, ChildProcess>()

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
    || null
  const file = resolveCookiesFile()

  return {
    file,
    fromBrowser,
    configured: Boolean(file || fromBrowser),
  }
}

export function getDownloadStatus(id: string): DownloadEntry | undefined {
  return downloads.get(id)
}

export function verifyYtDlp(): { ok: boolean; version?: string; error?: string } {
  const result = spawnSync(YTDLP_BIN, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || 'yt-dlp not found' }
  }
  return { ok: true, version: result.stdout?.trim() }
}

export function downloadVideo(url: string): string {
  const id = generateId()
  const filePath = getTempFilePath(id)

  const entry: DownloadEntry = { id, url, filePath, status: 'pending' }
  downloads.set(id, entry)

  runDownloadProcess(normalizeUrl(url), filePath, id)

  return id
}

export function cancelDownload(id: string): boolean {
  const entry = downloads.get(id)
  if (!entry || entry.status !== 'pending') return false

  entry.status = 'cancelled'
  console.log(`⏹️  [${id}] Download cancelled`)

  const child = processes.get(id)
  if (child && !child.killed) {
    child.kill('SIGTERM')
  }

  cleanupDownloadArtifacts(id)
  setTimeout(() => downloads.delete(id), 60_000)
  return true
}

function generateId(): string {
  return crypto.randomUUID()
}

function getTempFilePath(id: string): string {
  return path.join(tmpdir(), `video-${id}.mp4`)
}

function normalizeUrl(url: string): string {
  return url
    .replace(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/, 'youtube.com/watch?v=$1')
    .replace(/youtu\.be\/([a-zA-Z0-9_-]+)/, 'youtube.com/watch?v=$1')
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
    ...getJsRuntimeArgs(),
    ...getProxyArgs(useProxy),
    ...getCookiesArgs(id, url),
    ...getPlatformArgs(url, attempt),
    '-o', filePath,
    url,
  ]

  return args
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
  if (manifestFromPage) {
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
    return [...DEFAULT_COOKIES_CANDIDATES, ...YOUTUBE_COOKIES_CANDIDATES, ...KINOPUB_COOKIES_CANDIDATES]
  }

  if (isYouTube(url)) {
    return [...YOUTUBE_COOKIES_CANDIDATES, ...DEFAULT_COOKIES_CANDIDATES]
  }

  if (isKinoPubRelated(url)) {
    return [...KINOPUB_COOKIES_CANDIDATES, ...DEFAULT_COOKIES_CANDIDATES]
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

  return process.env.COOKIES_FROM_BROWSER?.trim() || null
}

function cleanupDownloadArtifacts(id: string): void {
  cleanupTempCookies(id)
  processes.delete(id)

  const entry = downloads.get(id)
  if (!entry) return

  fs.unlink(entry.filePath, () => {})
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

  const fallbacks = hasCookies
    ? ['web,web_safari', 'mweb,android_vr', 'android,web']
    : [null, 'mweb,android_vr,web_safari', 'android,web']

  return fallbacks[attempt] ?? fallbacks[fallbacks.length - 1]!
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

    if (code === 0) {
      if (!verifyDownloadedFile(id, filePath, entry)) {
        cleanupDownloadArtifacts(id)
        return
      }
      entry.status = 'done'
      scheduleCleanup(entry)
      cleanupTempCookies(id)
      return
    }

    // Some extractors can return non-zero for playlist side-errors
    // even when the target file is already downloaded correctly.
    if (verifyDownloadedFile(id, filePath, entry)) {
      console.warn(`⚠️  [${id}] yt-dlp exited with code ${code}, but file is valid. Marking as done.`)
      entry.status = 'done'
      scheduleCleanup(entry)
      cleanupTempCookies(id)
      return
    }

    if (tryRetry(id, filePath, entry, logSummary, ctx)) return

    failDownload(id, entry, logSummary, code ?? undefined)
    cleanupDownloadArtifacts(id)
  })
}

function verifyDownloadedFile(id: string, filePath: string, entry: DownloadEntry): boolean {
  const resolvedFilePath = resolveDownloadedFilePath(filePath)
  if (!resolvedFilePath) {
    failDownload(id, entry, 'File not found after download')
    return false
  }

  if (resolvedFilePath !== entry.filePath) {
    console.log(`ℹ️  [${id}] Resolved output file: ${resolvedFilePath}`)
    entry.filePath = resolvedFilePath
  }

  try {
    const stats = fs.statSync(entry.filePath)
    if (stats.size === 0) {
      failDownload(id, entry, 'Downloaded file is empty')
      return false
    }
    console.log(`✅  [${id}] Download complete (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
    return true
  } catch (error) {
    failDownload(id, entry, `Unable to read downloaded file: ${(error as Error).message}`)
    return false
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
  setTimeout(() => {
    fs.unlink(entry.filePath, () => {})
    downloads.delete(entry.id)
  }, 5 * 60 * 1000)
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
