import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

/**
 * Cookie владельца сервиса не должны уезжать на посторонний хост:
 * иначе достаточно прислать ссылку на свой сервер, чтобы получить
 * его сессии YouTube/kino.pub/Instagram/Facebook.
 *
 * Пути к cookie-файлам читаются на этапе загрузки модуля, поэтому
 * переменные окружения выставляем до динамического импорта.
 */

const fixturesDir = path.join(tmpdir(), `cookies-fixtures-${process.pid}`)
const file = (name: string) => path.join(fixturesDir, name)

let downloader: typeof import('./downloader')

beforeAll(async () => {
  fs.mkdirSync(fixturesDir, { recursive: true })
  for (const name of ['default.txt', 'youtube.txt', 'kinopub.txt', 'instagram.txt', 'facebook.txt']) {
    fs.writeFileSync(file(name), '# Netscape HTTP Cookie File\n')
  }

  process.env.COOKIES_FILE = file('default.txt')
  process.env.YT_COOKIES_FILE = file('youtube.txt')
  process.env.KINOPUB_COOKIES_FILE = file('kinopub.txt')
  process.env.INSTAGRAM_COOKIES_FILE = file('instagram.txt')
  process.env.FACEBOOK_COOKIES_FILE = file('facebook.txt')
  process.env.COOKIES_FROM_BROWSER = ''

  downloader = await import('./downloader')
})

afterAll(() => {
  fs.rmSync(fixturesDir, { recursive: true, force: true })
})

describe('выбор cookie по площадке', () => {
  const matched: Array<[string, string]> = [
    ['https://www.youtube.com/watch?v=x', 'youtube.txt'],
    ['https://youtu.be/x', 'youtube.txt'],
    ['https://kino.pub/item/view/1', 'kinopub.txt'],
    ['https://cdn.cdntogo.net/x/master.m3u8', 'kinopub.txt'],
    ['https://www.instagram.com/reel/abc/', 'instagram.txt'],
    ['https://www.facebook.com/watch/?v=1', 'facebook.txt'],
  ]

  for (const [url, expected] of matched) {
    test(`${url} → ${expected}`, () => {
      expect(downloader.resolveCookiesFile(url)).toBe(file(expected))
    })
  }
})

describe('посторонний хост не получает cookie', () => {
  // Белый список такие хосты и так не пропустит — это второй рубеж
  // на случай, если ALLOWED_HOSTS расширят.
  const foreign = [
    'https://example.com/video.mp4',
    'http://attacker.tld/collect',
    // Площадка в пути, а не в хосте — не должна выглядеть как совпадение
    'https://attacker.tld/youtube.com/watch?v=x',
    // Домен-обманка: youtube.com.attacker.tld
    'https://youtube.com.attacker.tld/watch?v=x',
    'https://notkino.pub/item/view/1',
  ]

  for (const url of foreign) {
    test(`нет файла cookie: ${url}`, () => {
      expect(downloader.resolveCookiesFile(url)).toBeNull()
    })

    test(`нет --cookies-from-browser: ${url}`, () => {
      process.env.COOKIES_FROM_BROWSER = 'chrome'
      try {
        expect(downloader.resolveCookiesFromBrowser(url)).toBeNull()
      } finally {
        process.env.COOKIES_FROM_BROWSER = ''
      }
    })

    test(`yt-dlp запускается без единого cookie-аргумента: ${url}`, () => {
      expect(downloader.getCookiesArgs('11111111-1111-1111-1111-111111111111', url)).toEqual([])
    })
  }
})

describe('--cookies-from-browser', () => {
  test('общий COOKIES_FROM_BROWSER работает для известной площадки', () => {
    process.env.COOKIES_FROM_BROWSER = 'chrome'
    try {
      expect(downloader.resolveCookiesFromBrowser('https://www.youtube.com/watch?v=x')).toBe('chrome')
    } finally {
      process.env.COOKIES_FROM_BROWSER = ''
    }
  })

  test('профиль площадки приоритетнее общего', () => {
    process.env.COOKIES_FROM_BROWSER = 'chrome'
    process.env.KINOPUB_COOKIES_FROM_BROWSER = 'firefox'
    try {
      expect(downloader.resolveCookiesFromBrowser('https://kino.pub/item/view/1')).toBe('firefox')
    } finally {
      process.env.COOKIES_FROM_BROWSER = ''
      delete process.env.KINOPUB_COOKIES_FROM_BROWSER
    }
  })
})

describe('известная площадка без своего файла', () => {
  test('откатывается на общий COOKIES_FILE', () => {
    fs.rmSync(file('youtube.txt'))
    try {
      expect(downloader.resolveCookiesFile('https://www.youtube.com/watch?v=x')).toBe(file('default.txt'))
    } finally {
      fs.writeFileSync(file('youtube.txt'), '# Netscape HTTP Cookie File\n')
    }
  })
})
