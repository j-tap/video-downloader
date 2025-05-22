import type { Request, Response } from 'express'
import { downloadVideo } from '../lib/downloader'

export function downloadHandler(req: Request, res: Response) {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'No URL provided' })

  const id = downloadVideo(url)
  res.json({ id })
}
