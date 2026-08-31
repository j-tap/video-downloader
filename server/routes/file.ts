import type { Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { getDownloadStatus } from '../lib/downloader'

/**
 * Расширение зависит от того, что реально получилось после remux:
 * обычно mp4, но если у источника не было совместимой дорожки,
 * yt-dlp мог оставить webm/mkv. Отдавать такой файл как video/mp4 нельзя —
 * браузер и плеер выбирают декодер по типу.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
}

export function fileHandler(req: Request, res: Response) {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'Missing ID' })

  const entry = getDownloadStatus(id, req.clientId)
  if (!entry || entry.status !== 'done') {
    return res.status(404).json({ error: 'File not ready' })
  }

  // Проверяем, что файл существует
  if (!fs.existsSync(entry.filePath)) {
    return res.status(404).json({ error: 'File not found' })
  }

  const extension = path.extname(entry.filePath).toLowerCase()

  // sendFile сам выставляет Content-Length и обрабатывает Range.
  // Раньше файл шёл голым createReadStream: заголовок `Accept-Ranges: bytes`
  // мы обещали, но перемотку и докачку не поддерживали, а браузер не знал
  // размер и показывал загрузку без прогресса.
  res.sendFile(entry.filePath, {
    headers: {
      'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="video-${Date.now()}${extension || '.mp4'}"`,
    },
  }, (error) => {
    if (!error) return

    // Клиент закрыл вкладку или отменил скачивание — это не ошибка сервера.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ECONNABORTED' || code === 'EPIPE' || res.headersSent) return

    console.error('Error streaming file:', error)
    res.status(500).json({ error: 'Error reading file' })
  })
}
