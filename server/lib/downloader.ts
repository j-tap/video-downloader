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

  if (ytRegex.test(url)) return runYouTubeDownload

  return runGenericDownload
}

function runGenericDownload(url: string, filePath: string, id: string): void {
  const args = [
    '--no-playlist',
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '-o', filePath,
    url
  ]

  runYtDlpProcess(args, id, filePath)
}

function runYouTubeDownload(url: string, filePath: string, id: string): void {
  const normalizedUrl = url.replace(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/, 'youtube.com/watch?v=$1')

  const args = [
    '--no-playlist',
    '--proxy', 'socks5://127.0.0.1:9050',
    '-f', '232+234/best',
    '--merge-output-format', 'mp4',
    '-o', filePath,
    normalizedUrl
  ]

  runYtDlpProcess(args, id, filePath)
}


function runYtDlpProcess(args: string[], id: string, filePath: string): void {
  console.log(`▶️ yt-dlp args:`, args.join(' '))

  const child = spawn('yt-dlp', args)
  const stderrChunks: string[] = []

  child.stdout.on('data', (data) => {
    console.log(`yt-dlp stdout [${id}]:`, data.toString())
  })

  child.stderr.on('data', (data) => {
    const message = data.toString()
    stderrChunks.push(message)
    console.error(`yt-dlp stderr [${id}]:`, message)
  })

  child.on('close', (code) => {
    const entry = downloads.get(id)
    if (!entry) return

    const logSummary = stderrChunks.join('').trim()

    if (code === 0) {
      console.log(`✅  [${id}] Download complete`)
      entry.status = 'done'
      scheduleCleanup(entry)
    } else {
      console.error(`❌  [${id}] yt-dlp exited with code ${code}`)
      console.error(`❗  [${id}] Full stderr:\n${logSummary}`)
      entry.status = 'error'
      entry.error = logSummary || `yt-dlp exited with code ${code}`
    }
  })
}

function scheduleCleanup(entry: DownloadEntry): void {
  setTimeout(() => {
    fs.unlink(entry.filePath, () => {})
    downloads.delete(entry.id)
  }, 5 * 60 * 1000)
}
