import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import crypto from 'crypto'
import { spawn } from 'child_process'

// Types

type Status = 'pending' | 'done' | 'error'

export interface DownloadEntry {
  id: string
  url: string
  filePath: string
  status: Status
  error?: string
  progress?: number // 0-100
}

// Storage for download entries

const downloads = new Map<string, DownloadEntry>()

export function getDownloadStatus(id: string): DownloadEntry | undefined {
  return downloads.get(id)
}

// Main download function

export function downloadVideo(url: string): string {
  const id = generateId()
  const filePath = getTempFilePath(id)

  const entry: DownloadEntry = { id, url, filePath, status: 'pending' }
  downloads.set(id, entry)

  runDownloadProcess(url, filePath, id)

  return id
}

// Functions

function generateId(): string {
  return crypto.randomUUID()
}

function getTempFilePath(id: string): string {
  return path.join(tmpdir(), `video-${id}.mp4`)
}

function runDownloadProcess(url: string, filePath: string, id: string): void {
  console.log(`▶️  [${id}] Starting download: ${url}. Output file: ${filePath}`)

  const handler = getDownloadHandler(url)
  handler(url, filePath, id)
}

function getDownloadHandler(url: string): (url: string, filePath: string, id: string) => void {
  const ytRegex = /youtube\.com|youtu\.be/
  const fbRegex = /facebook\.com|fb\.com|fb\.watch/
  const igRegex = /instagram\.com|instagr\.am/

  if (ytRegex.test(url)) return runYouTubeDownload
  if (fbRegex.test(url)) return runFacebookDownload
  if (igRegex.test(url)) return runInstagramDownload

  return runGenericDownload
}

function runFacebookDownload(url: string, filePath: string, id: string): void {
  // Для Facebook: забираем лучшую пару видео+аудио и перекодируем в «универсальный» MP4 (H.264 + AAC),
  // чтобы избежать ситуации, когда плеер не умеет исходный видеокодек (AV1/VP9 и т.п.) и показывает только звук.
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '30',
    '--retries', '3',
    // Берём лучшую пару видео+аудио, если недоступно — best
    '-f', 'bv*+ba/b',
    // Перекодируем в MP4 (H.264 + AAC, совместимый почти везде)
    '--recode-video', 'mp4',
    '--postprocessor-args', 'ffmpeg:-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart',
    '-o', filePath,
    url
  ]

  runYtDlpProcess(args, id, filePath, false)
}

function runInstagramDownload(url: string, filePath: string, id: string): void {
  // Для Instagram: аналогично Facebook — забираем лучшую пару видео+аудио и перекодируем в совместимый MP4
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '30',
    '--retries', '3',
    // предпочтительно берём пару video+audio, если нет — best
    '-f', 'bv*+ba/b',
    '--recode-video', 'mp4',
    '--postprocessor-args', 'ffmpeg:-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart',
    '-o', filePath,
    url
  ]

  runYtDlpProcess(args, id, filePath, false)
}

function runGenericDownload(url: string, filePath: string, id: string): void {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '30',
    '--retries', '3',
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    '-o', filePath,
    url
  ]

  runYtDlpProcess(args, id, filePath, false)
}

function runYouTubeDownload(url: string, filePath: string, id: string): void {
  const normalizedUrl = url.replace(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/, 'youtube.com/watch?v=$1')

  // Прокси опционален, берем из переменной окружения
  const proxy = process.env.YT_PROXY || process.env.PROXY
  
  const args: string[] = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '30',
    '--retries', '3',
    '--extractor-args', 'youtube:player_client=android,web',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-check-certificate',
    '-o', filePath,
    normalizedUrl
  ]

  // Добавляем прокси только если он задан (после --no-playlist)
  if (proxy) {
    args.splice(1, 0, '--proxy', proxy)
  }

  runYtDlpProcess(args, id, filePath, true)
}


function runYtDlpProcess(args: string[], id: string, filePath: string, retryWithoutProxy: boolean = false): void {
  console.log(`▶️ yt-dlp args:`, args.join(' '))

  const child = spawn('yt-dlp', args)
  const stderrChunks: string[] = []

  child.stdout.on('data', (data) => {
    const message = data.toString()
    console.log(`yt-dlp stdout [${id}]:`, message)

    // yt-dlp в новых версиях часто пишет прогресс в stdout, поэтому тоже парсим его здесь
    const progress = parseProgress(message)
    if (progress !== null) {
      const entry = downloads.get(id)
      if (entry) {
        entry.progress = progress
      }
    }
  })

  child.stderr.on('data', (data) => {
    const message = data.toString()
    stderrChunks.push(message)
    console.error(`yt-dlp stderr [${id}]:`, message)
    
    // Парсим прогресс из вывода yt-dlp
    const progress = parseProgress(message)
    if (progress !== null) {
      const entry = downloads.get(id)
      if (entry) {
        entry.progress = progress
      }
    }
  })

  child.on('close', (code) => {
    const entry = downloads.get(id)
    if (!entry) return

    const logSummary = stderrChunks.join('').trim()

    if (code === 0) {
      // Проверяем, что файл действительно создан и не пустой
      try {
        const stats = fs.statSync(filePath)
        if (stats.size === 0) {
          console.error(`❌  [${id}] Downloaded file is empty`)
          entry.status = 'error'
          entry.error = 'Downloaded file is empty'
          return
        }
        console.log(`✅  [${id}] Download complete (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
      } catch (err) {
        console.error(`❌  [${id}] File not found after download:`, err)
        entry.status = 'error'
        entry.error = 'File not found after download'
        return
      }
      entry.status = 'done'
      scheduleCleanup(entry)
    } else {
      // Проверяем, используется ли прокси в аргументах
      const hasProxy = args.includes('--proxy')
      
      // Если ошибка связана с прокси/таймаутом и это YouTube, пробуем без прокси
      const isProxyError = logSummary.includes('timed out') || 
                          logSummary.includes('proxy') || 
                          logSummary.includes('Connection refused') ||
                          logSummary.includes('SocksHTTPSConnection') ||
                          logSummary.includes('Unable to download') ||
                          logSummary.includes('Failed to establish')
      
      const isYouTube = entry.url.match(/youtube\.com|youtu\.be/)
      
      console.log(`[${id}] Error check: retryWithoutProxy=${retryWithoutProxy}, hasProxy=${hasProxy}, isProxyError=${isProxyError}, isYouTube=${!!isYouTube}`)
      
      if (retryWithoutProxy && hasProxy && isProxyError && isYouTube) {
        console.log(`⚠️  [${id}] Proxy error detected (Connection refused), retrying without proxy...`)
        const normalizedUrl = entry.url.replace(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/, 'youtube.com/watch?v=$1')
        const retryArgs = [
          '--no-playlist',
          '--no-warnings',
          '--socket-timeout', '30',
          '--retries', '3',
          '--extractor-args', 'youtube:player_client=android,web',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '--merge-output-format', 'mp4',
          '--no-check-certificate',
          '-o', filePath,
          normalizedUrl
        ]
        // Не передаем retryWithoutProxy чтобы избежать бесконечного цикла
        runYtDlpProcess(retryArgs, id, filePath, false)
        return
      }

      console.error(`❌  [${id}] yt-dlp exited with code ${code}`)
      console.error(`❗  [${id}] Full stderr:\n${logSummary}`)
      entry.status = 'error'
      
      // Улучшаем сообщение об ошибке, убирая лишние предупреждения
      const cleanError = cleanErrorMessage(logSummary)
      entry.error = cleanError || `yt-dlp exited with code ${code}`
    }
  })
}

function scheduleCleanup(entry: DownloadEntry): void {
  setTimeout(() => {
    fs.unlink(entry.filePath, () => {})
    downloads.delete(entry.id)
  }, 5 * 60 * 1000)
}

function parseProgress(message: string): number | null {
  // yt-dlp выводит прогресс в формате: [download] 45.2% of 123.45MiB at 1.23MiB/s ETA 00:45
  // или: [download] 100% of 123.45MiB in 00:45
  const percentMatch = message.match(/\[download\]\s+(\d+\.?\d*)%/)
  if (percentMatch) {
    const raw = percentMatch[1]
    if (!raw) return null
    const percent = parseFloat(raw)
    return Math.min(100, Math.max(0, percent))
  }
  return null
}

function cleanErrorMessage(error: string): string {
  // Убираем предупреждения о версии и оставляем только важные ошибки
  const lines = error.split('\n')
  const importantLines: string[] = []
  
  // Проверяем на ошибки прокси
  if (error.includes('Connection refused') && error.includes('SocksHTTPSConnection')) {
    return 'Ошибка подключения к прокси-серверу. Попробуйте без прокси или проверьте настройки прокси.'
  }
  
  for (const line of lines) {
    // Пропускаем предупреждения о версии
    if (line.includes('yt-dlp version') && line.includes('older than')) continue
    // Пропускаем предупреждения о retry
    if (line.includes('Retrying')) continue
    // Пропускаем технические детали прокси
    if (line.includes('SocksHTTPSConnection') && line.includes('object at')) continue
    // Оставляем только ERROR и важные WARNING
    if (line.includes('ERROR:') || 
        (line.includes('WARNING:') && (line.includes('Unable to download') || line.includes('timed out') || line.includes('Failed to extract')))) {
      importantLines.push(line)
    }
  }
  
  if (importantLines.length === 0) {
    // Если нет важных строк, берем последнюю строку с ERROR
    const errorLine = lines.find(line => line.includes('ERROR:'))
    if (errorLine) return errorLine.trim()
    return error.trim()
  }
  
  return importantLines.join(' ').trim()
}
