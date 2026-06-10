import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'

type Status = 'pending' | 'done' | 'error'

export interface DownloadEntry {
  id: string
  url: string
  filePath: string
  status: Status
  error?: string
  progress?: number
}

const downloads = new Map<string, DownloadEntry>()

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp'

const COOKIES_CANDIDATES = [
  process.env.YT_COOKIES_FILE,
  path.join(process.cwd(), 'data', 'cookiesYoutube.txt'),
  '/app/data/cookiesYoutube.txt',
].filter(Boolean) as string[]

let resolvedCookiesFile: string | null = null

export function resolveCookiesFile(): string | null {
  if (resolvedCookiesFile !== null) {
    return resolvedCookiesFile || null
  }

  for (const candidate of COOKIES_CANDIDATES) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(process.cwd(), candidate)

    if (fs.existsSync(resolved)) {
      resolvedCookiesFile = resolved
      return resolved
    }
  }

  resolvedCookiesFile = ''
  return null
}

export function getCookiesConfig(): {
  file: string | null
  fromBrowser: string | null
  configured: boolean
} {
  const fromBrowser = process.env.YT_COOKIES_FROM_BROWSER?.trim() || null
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
  console.log(`▶️  [${id}] Starting download: ${url}`)

  const args = buildYtDlpArgs(url, filePath, id, { attempt: 0 })
  runYtDlpProcess(args, id, filePath, { url, filePath, attempt: 0, useProxy: true })
}

interface BuildOptions {
  attempt?: number
  useProxy?: boolean
}

function buildYtDlpArgs(url: string, filePath: string, id: string, options: BuildOptions = {}): string[] {
  const { attempt = 0, useProxy = true } = options
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--socket-timeout', '30',
    '--retries', '5',
    '--fragment-retries', '5',
    ...getJsRuntimeArgs(),
    ...getProxyArgs(useProxy),
    ...getCookiesArgs(id),
    ...getPlatformArgs(url, attempt),
    '-o', filePath,
    url,
  ]

  return args
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

function getCookiesArgs(id: string): string[] {
  const fromBrowser = process.env.YT_COOKIES_FROM_BROWSER?.trim()
  if (fromBrowser) {
    return ['--cookies-from-browser', fromBrowser]
  }

  const cookiesFile = resolveCookiesFile()
  if (!cookiesFile) return []

  const tmpCookies = getTempCookiesPath(id)
  fs.copyFileSync(cookiesFile, tmpCookies)
  return ['--cookies', tmpCookies]
}

function cleanupTempCookies(id: string): void {
  fs.unlink(getTempCookiesPath(id), () => {})
}

function isYouTube(url: string): boolean {
  return /youtube\.com|youtu\.be/.test(url)
}

function isFacebook(url: string): boolean {
  return /facebook\.com|fb\.com|fb\.watch/.test(url)
}

function isInstagram(url: string): boolean {
  return /instagram\.com|instagr\.am/.test(url)
}

function getPlatformArgs(url: string, attempt: number): string[] {
  if (isYouTube(url)) {
    return getYouTubeArgs(attempt)
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
}

function runYtDlpProcess(
  args: string[],
  id: string,
  filePath: string,
  ctx: RunContext,
): void {
  console.log(`▶️ yt-dlp [attempt ${ctx.attempt}]:`, args.join(' '))

  const child = spawn(YTDLP_BIN, args)
  const stderrChunks: string[] = []

  const handleOutput = (message: string) => {
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
    const entry = downloads.get(id)
    if (!entry) return

    const logSummary = stderrChunks.join('').trim()

    if (code === 0) {
      if (!verifyDownloadedFile(id, filePath, entry)) {
        cleanupTempCookies(id)
        return
      }
      entry.status = 'done'
      scheduleCleanup(entry)
      cleanupTempCookies(id)
      return
    }

    if (tryRetry(id, filePath, entry, logSummary, ctx)) return

    console.error(`❌  [${id}] yt-dlp exited with code ${code}`)
    entry.status = 'error'
    entry.error = cleanErrorMessage(logSummary) || `yt-dlp exited with code ${code}`
    cleanupTempCookies(id)
  })
}

function verifyDownloadedFile(id: string, filePath: string, entry: DownloadEntry): boolean {
  try {
    const stats = fs.statSync(filePath)
    if (stats.size === 0) {
      entry.status = 'error'
      entry.error = 'Скачанный файл пустой'
      return false
    }
    console.log(`✅  [${id}] Download complete (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
    return true
  } catch {
    entry.status = 'error'
    entry.error = 'Файл не найден после скачивания'
    return false
  }
}

function tryRetry(
  id: string,
  filePath: string,
  entry: DownloadEntry,
  logSummary: string,
  ctx: RunContext,
): boolean {
  const hasProxy = ctx.useProxy && (process.env.YT_PROXY || process.env.PROXY) !== undefined
  const isProxyError = /timed out|proxy|Connection refused|SocksHTTPSConnection|Unable to download|Failed to establish/i.test(logSummary)
  const isYouTubeError = isYouTube(entry.url) && /PO Token|reloaded|403|Sign in|age.restricted|format.*not available/i.test(logSummary)

  if (hasProxy && isProxyError) {
    console.log(`⚠️  [${id}] Proxy error, retrying without proxy...`)
    const retryArgs = buildYtDlpArgs(ctx.url, filePath, id, { attempt: ctx.attempt, useProxy: false })
    runYtDlpProcess(retryArgs, id, filePath, { ...ctx, useProxy: false })
    return true
  }

  if (isYouTubeError && ctx.attempt < 2 && !process.env.YT_PLAYER_CLIENT) {
    const nextAttempt = ctx.attempt + 1
    console.log(`⚠️  [${id}] YouTube error, retrying with fallback player_client (attempt ${nextAttempt})...`)
    const retryArgs = buildYtDlpArgs(ctx.url, filePath, id, { attempt: nextAttempt, useProxy: ctx.useProxy })
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
        (line.includes('WARNING:') && /Unable to download|timed out|Failed to extract|PO Token|reloaded/i.test(line))) {
      importantLines.push(line)
    }
  }

  if (importantLines.length > 0) {
    return importantLines.join(' ').trim()
  }

  const errorLine = lines.find(line => line.includes('ERROR:'))
  return errorLine?.trim() || error.trim()
}
