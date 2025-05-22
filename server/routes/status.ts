import type { Request, Response } from 'express'
import { getDownloadStatus } from '../lib/downloader'

export function statusHandler(req: Request, res: Response) {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'Missing ID' })

  const entry = getDownloadStatus(id)
  if (!entry) return res.status(404).json({ error: 'Not found' })

  res.json({ status: entry.status, error: entry.error })
}
