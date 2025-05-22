import type { Request, Response } from 'express'
import { getDownloadStatus } from '../lib/downloader'

export function fileHandler(req: Request, res: Response) {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'Missing ID' })

  const entry = getDownloadStatus(id)
  if (!entry || entry.status !== 'done') {
    return res.status(404).json({ error: 'File not ready' })
  }

  const filename = `video-${new Date().getTime()}.mp4`
  res.download(entry.filePath, filename)
}
