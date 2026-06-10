import type { Request, Response } from 'express'
import { cancelDownload } from '../lib/downloader'

export function cancelHandler(req: Request, res: Response) {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'Missing ID' })

  const cancelled = cancelDownload(id)
  if (!cancelled) return res.status(404).json({ error: 'Not found or not active' })

  res.json({ status: 'cancelled' })
}
