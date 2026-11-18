import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { classifyYtDlpOutput, ERROR_CODES, isErrorCode } from './errorCodes'
import { getSiteMessage } from './siteMessages'

/**
 * Образцы stderr yt-dlp лежат в __fixtures__/ytdlp-stderr, ожидаемый код —
 * в имени файла до `--`. Часть образцов снята с живых площадок (Rutube 404,
 * удалённое видео VK, Instagram без входа, TikTok с закрытого адреса),
 * часть — известные сообщения экстракторов yt-dlp.
 */
const FIXTURES = path.join(import.meta.dir, '__fixtures__', 'ytdlp-stderr')

describe('разбор вывода yt-dlp в коды договора', () => {
  const files = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.txt'))

  test('образцы на месте', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  for (const name of files) {
    const expected = name.split('--')[0] ?? ''

    test(`${name} → ${expected}`, () => {
      expect(isErrorCode(expected)).toBe(true)
      const output = fs.readFileSync(path.join(FIXTURES, name), 'utf8')
      expect(classifyYtDlpOutput(output).code).toBe(expected as never)
    })
  }

  test('проверка на бота — не «закрытый ролик», а отказ адресу', () => {
    const output = fs.readFileSync(path.join(FIXTURES, 'source_unreachable--youtube-bot-check.txt'), 'utf8')
    expect(classifyYtDlpOutput(output)).toEqual({ code: 'source_unreachable', reason: 'bot_check' })
  })

  test('YouTube «No video formats found» — сервер не пустили, а не пост без видео', () => {
    const output = 'ERROR: [youtube] abc: No video formats found!'
    expect(classifyYtDlpOutput(output, { youtube: true }).code).toBe('source_unreachable')
    expect(classifyYtDlpOutput(output).code).toBe('no_video')
  })

  test('незнакомый вывод — internal', () => {
    expect(classifyYtDlpOutput('ERROR: something completely new').code).toBe('internal')
    expect(classifyYtDlpOutput('').code).toBe('internal')
  })
})

describe('retryable совпадает со столбцом «повтор» договора', () => {
  const retryable = ['source_unreachable', 'processing_failed', 'timeout', 'queue_full', 'rate_limited', 'job_not_found', 'file_expired', 'internal']
  const final = ['url_invalid', 'site_unsupported', 'playlist_not_allowed', 'no_video', 'live_stream', 'private', 'not_found', 'geo_blocked', 'drm', 'too_long', 'too_large', 'unauthorized', 'forbidden', 'cancelled']

  for (const code of retryable) {
    test(`${code}: да`, () => expect(ERROR_CODES[code as keyof typeof ERROR_CODES].retryable).toBe(true))
  }
  for (const code of final) {
    test(`${code}: нет`, () => expect(ERROR_CODES[code as keyof typeof ERROR_CODES].retryable).toBe(false))
  }
})

describe('текст сайта строится из кода', () => {
  test('уточнения сайта сохранились', () => {
    expect(getSiteMessage({ code: 'source_unreachable', reason: 'bot_check' })).toContain('YouTube сейчас не пускает')
    expect(getSiteMessage({ code: 'not_found', reason: 'story_missing' })).toContain('история не найдена')
    expect(getSiteMessage({ code: 'private', reason: 'trailer_only' })).toContain('только трейлер')
    expect(getSiteMessage({ code: 'internal', reason: 'bad_file' })).toContain('некорректный файл')
  })

  test('у каждого кода разбора есть понятный текст без внутренностей', () => {
    for (const name of fs.readdirSync(FIXTURES)) {
      const message = getSiteMessage(classifyYtDlpOutput(fs.readFileSync(path.join(FIXTURES, name), 'utf8')))
      expect(message).not.toMatch(/ERROR|yt-dlp|cookies|PROXY|https?:/)
    }
  })
})
