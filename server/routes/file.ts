import type { Request, Response } from 'express'
import { getDownloadStatus } from '../lib/downloader'
import fs from 'fs'

export function fileHandler(req: Request, res: Response) {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'Missing ID' })

  const entry = getDownloadStatus(id)
  if (!entry || entry.status !== 'done') {
    return res.status(404).json({ error: 'File not ready' })
  }

  // Проверяем, что файл существует
  if (!fs.existsSync(entry.filePath)) {
    return res.status(404).json({ error: 'File not found' })
  }

  // Устанавливаем правильные заголовки для видео
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', `attachment; filename="video-${new Date().getTime()}.mp4"`)
  res.setHeader('Accept-Ranges', 'bytes')
  
  // Отправляем файл
  const fileStream = fs.createReadStream(entry.filePath)
  fileStream.pipe(res)
  
  fileStream.on('error', (err) => {
    console.error('Error streaming file:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading file' })
    }
  })
}
