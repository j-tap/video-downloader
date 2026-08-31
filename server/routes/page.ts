import type { Request, Response } from 'express'
import fs from 'fs/promises'
import path from 'path'

/**
 * Виджет vr9 (`wcopy-vrnine.js`) дописывает свою разметку внутрь `.vr9copy`
 * через appendChild, поэтому статичная ссылка оставалась на месте и в футере
 * оказывалось два копирайта сразу. Живому посетителю отдаём футер без ссылки:
 * её место займёт виджет. Краулерам ссылка нужна, а скрипт они всё равно
 * не выполняют — поэтому им HTML уходит как есть.
 *
 * Блок помечен в client/index.html атрибутом `data-bot-only`.
 */
const BOT_ONLY_BLOCK = /[ \t]*<span data-bot-only>[\s\S]*?<\/span>\n?/g

/**
 * Список специально широкий: пропустить краулера в «человеческую» версию
 * дешевле, чем показать живому посетителю дубль копирайта.
 */
const BOT_USER_AGENT = /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|vkshare|skypeuripreview|discord|preview|scrape|lighthouse|pagespeed|headless|python-requests|curl|wget/i

export function isBotRequest(userAgent: string | undefined): boolean {
  if (!userAgent) return true
  return BOT_USER_AGENT.test(userAgent)
}

export function renderIndexHtml(html: string, forBot: boolean): string {
  return forBot ? html : html.replace(BOT_ONLY_BLOCK, '')
}

export function createPageHandler(clientPath: string) {
  const indexPath = path.join(clientPath, 'index.html')

  return async function pageHandler(req: Request, res: Response): Promise<void> {
    let html: string
    try {
      html = await fs.readFile(indexPath, 'utf8')
    } catch (error) {
      console.error('Unable to read index.html:', error)
      res.status(500).send('Internal Server Error')
      return
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    // Ответ зависит от User-Agent — без Vary промежуточный кеш мог бы отдать
    // версию для бота живому посетителю (и наоборот).
    res.setHeader('Vary', 'User-Agent')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')

    res.send(renderIndexHtml(html, isBotRequest(req.get('user-agent'))))
  }
}
