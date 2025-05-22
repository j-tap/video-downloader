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
  const args = ['--no-playlist', '-f', 'best[ext=mp4]/mp4', '-o', filePath, url]
  const child = spawn('yt-dlp', args)

  child.stderr.on('data', (data) => {
    console.error(`yt-dlp stderr [${id}]:`, data.toString())
  })

  child.on('close', (code) => {
    const entry = downloads.get(id)
    if (!entry) return

    if (code === 0) {
      entry.status = 'done'
      scheduleCleanup(entry)
    } else {
      entry.status = 'error'
      entry.error = `yt-dlp exited with code ${code}`
    }
  })
}

function scheduleCleanup(entry: DownloadEntry): void {
  setTimeout(() => {
    fs.unlink(entry.filePath, () => {})
    downloads.delete(entry.id)
  }, 5 * 60 * 1000)
}
