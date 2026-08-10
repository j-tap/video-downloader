import type { Request, Response } from 'express'
import { startDownload } from '../lib/downloader'
import { assertPublicUrl } from '../lib/security/urlGuard'
import { getClientIp } from '../lib/security/rateLimit'

export async function downloadHandler(req: Request, res: Response) {
  const { url } = req.body ?? {}

  if (typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({ error: 'Не указана ссылка.' })
  }

  const guard = await assertPublicUrl(url)
  if (!guard.ok) {
    console.warn(`⛔ Blocked URL from ${getClientIp(req)}: ${guard.detail || guard.error}`)
    return res.status(403).json({ error: guard.error })
  }

  const result = startDownload(url.trim(), {
    clientId: req.clientId,
    ip: getClientIp(req),
  })

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error })
  }

  return res.json({ id: result.id })
}
