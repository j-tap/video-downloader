import type { Request, Response } from 'express'
import { downloadVideo } from '../lib/downloader'

export function downloadHandler(req: Request, res: Response) {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'No URL provided' })
  if (!isHttpUrl(url)) return res.status(400).json({ error: 'Invalid URL' })

  const id = downloadVideo(url)
  res.json({ id })
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
