import { describe, expect, test } from 'bun:test'
import { assertPublicUrl, isPublicUrlSync } from './urlGuard'
import { isPrivateIp } from './ip'

describe('assertPublicUrl', () => {
  const blocked = [
    ['метаданные облака', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1/'],
    ['loopback + порт сервиса', 'http://127.0.0.1:9090'],
    ['внутренняя сеть', 'http://172.22.1.10:3306'],
    ['внутренняя сеть, порт 80', 'http://172.22.1.10/'],
    ['частная сеть 10/8', 'http://10.0.0.5/'],
    ['частная сеть 192.168', 'http://192.168.1.1/'],
    ['CGNAT', 'http://100.64.1.1/'],
    ['this-network', 'http://0.0.0.0/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6-mapped IPv4', 'http://[::ffff:127.0.0.1]/'],
    ['IPv6 ULA', 'http://[fd00::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['десятичная запись IP', 'http://2130706433/'],
    ['hex-запись IP', 'http://0x7f.0x0.0x0.0x1/'],
    ['имя контейнера', 'http://mysql/'],
    ['внутренняя зона .internal', 'http://mailcow.internal/'],
    ['внутренняя зона .local', 'http://prometheus.local/'],
    ['credentials для подмены хоста', 'http://user:pass@evil.com@127.0.0.1/'],
    ['нестандартный порт', 'https://youtube.com:8080/'],
    ['схема file', 'file:///etc/passwd'],
    ['схема ftp', 'ftp://youtube.com/x'],
    ['посторонний сайт', 'https://example.com/video.mp4'],
    ['посторонний сайт по http', 'http://example.com/video'],
    ['неподдерживаемая площадка', 'https://vimeo.com/76979871'],
    ['похожий домен-обманка', 'https://youtube.com.evil.tld/watch?v=x'],
    ['площадка как путь, а не хост', 'https://evil.tld/youtube.com/watch'],
  ] as const

  for (const [name, url] of blocked) {
    test(`блокирует: ${name}`, async () => {
      const result = await assertPublicUrl(url)
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    })
  }

  const allowed = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.instagram.com/reel/abc/',
    'https://www.facebook.com/watch/?v=123',
    'https://fb.watch/abc/',
    'https://kino.pub/item/view/123',
    'https://cdn.cdntogo.net/x/master.m3u8',
  ]

  for (const url of allowed) {
    test(`пропускает: ${url}`, async () => {
      const result = await assertPublicUrl(url)
      expect(result.ok).toBe(true)
    })
  }

  test('пустая строка отклоняется', async () => {
    expect((await assertPublicUrl('')).ok).toBe(false)
  })

  test('слишком длинный URL отклоняется', async () => {
    expect((await assertPublicUrl(`https://youtube.com/${'a'.repeat(3000)}`)).ok).toBe(false)
  })

  test('в тексте ошибки перечислены поддерживаемые площадки', async () => {
    const result = await assertPublicUrl('https://example.com/video.mp4')
    expect(result.error).toContain('YouTube')
    expect(result.error).toContain('kino.pub')
  })
})

describe('isPublicUrlSync', () => {
  test('манифест с внутреннего адреса не принимается', () => {
    expect(isPublicUrlSync('http://10.1.2.3/master.m3u8', { enforceAllowlist: false })).toBe(false)
  })

  test('обычный CDN-манифест принимается', () => {
    expect(isPublicUrlSync('https://cdn.cdntogo.net/x/master.m3u8')).toBe(true)
  })

  test('манифест со стороннего CDN проходит без белого списка', () => {
    expect(isPublicUrlSync('https://other-cdn.example/x/master.m3u8', { enforceAllowlist: false })).toBe(true)
  })

  test('но белый список по умолчанию такой хост не пропускает', () => {
    expect(isPublicUrlSync('https://other-cdn.example/x/master.m3u8')).toBe(false)
  })
})

describe('isPrivateIp', () => {
  const cases: Array<[string, boolean]> = [
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.169.254', true],
    ['192.168.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['::1', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['2606:4700:4700::1111', false],
    ['2002:0a00:0001::1', true],
    ['мусор', true],
  ]

  for (const [ip, expected] of cases) {
    test(`${ip} → ${expected ? 'приватный' : 'публичный'}`, () => {
      expect(isPrivateIp(ip)).toBe(expected)
    })
  }
})
