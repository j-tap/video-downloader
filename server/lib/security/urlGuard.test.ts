import { afterEach, describe, expect, test } from 'bun:test'
import { assertPublicUrl, checkRedirectChain, isPublicUrlSync } from './urlGuard'
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
    'https://www.tiktok.com/@user/video/7206382937372134662',
    'https://vm.tiktok.com/ZMabcdef/',
    'https://vt.tiktok.com/ZSabcdef/',
    'https://vk.com/video-50883936_456244102',
    'https://vk.ru/video-220754053_456242564',
    'https://vkvideo.ru/video-50883936_456244102',
    'https://rutube.ru/video/3eac3b4561676c17df9132a9a1e62e3e/',
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

  test('машинный код отказа: чужой сайт — site_unsupported, остальное — url_invalid', async () => {
    expect((await assertPublicUrl('https://vimeo.com/76979871')).code).toBe('site_unsupported')
    expect((await assertPublicUrl('http://127.0.0.1/')).code).toBe('url_invalid')
    expect((await assertPublicUrl('ftp://youtube.com/x')).code).toBe('url_invalid')
    expect((await assertPublicUrl('https://tiktok.com.evil.tld/@a/video/1')).code).toBe('site_unsupported')
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

describe('checkRedirectChain', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Отдаёт ответы по порядку вызовов; строка = Location для 302. */
  function mockFetch(responses: Array<string | number | Error>) {
    const calls: string[] = []
    let index = 0

    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      const next = responses[index++] ?? 200

      if (next instanceof Error) throw next
      if (typeof next === 'number') return new Response(null, { status: next })
      return new Response(null, { status: 302, headers: { location: next } })
    }) as typeof fetch

    return calls
  }

  test('редирект на метаданные облака блокируется', async () => {
    mockFetch(['http://169.254.169.254/latest/meta-data/'])
    const result = await checkRedirectChain('https://www.youtube.com/watch?v=x')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('внутренний адрес')
  })

  test('редирект во внутреннюю docker-сеть блокируется', async () => {
    mockFetch(['http://172.20.0.17:9090/api/v1/label/__name__/values'])
    expect((await checkRedirectChain('https://www.youtube.com/watch?v=x')).ok).toBe(false)
  })

  test('блокируется и на втором шаге цепочки', async () => {
    mockFetch(['https://youtu.be/abc', 'http://10.0.0.5/'])
    expect((await checkRedirectChain('https://www.youtube.com/watch?v=x')).ok).toBe(false)
  })

  test('относительный Location разбирается относительно текущего URL', async () => {
    const calls = mockFetch(['/watch?v=abc', 200])
    const result = await checkRedirectChain('https://www.youtube.com/x')

    expect(result.ok).toBe(true)
    expect(calls[1]).toBe('https://www.youtube.com/watch?v=abc')
  })

  test('обычный редирект на публичный хост пропускается', async () => {
    mockFetch(['https://www.youtube.com/watch?v=abc', 200])
    expect((await checkRedirectChain('https://youtu.be/abc')).ok).toBe(true)
  })

  test('ответ без редиректа пропускается', async () => {
    mockFetch([200])
    expect((await checkRedirectChain('https://www.youtube.com/watch?v=x')).ok).toBe(true)
  })

  test('сетевая ошибка не блокирует загрузку', async () => {
    mockFetch([new Error('ECONNREFUSED')])
    expect((await checkRedirectChain('https://www.youtube.com/watch?v=x')).ok).toBe(true)
  })

  test('бесконечный цикл редиректов обрывается', async () => {
    const calls = mockFetch(Array<string>(20).fill('https://www.youtube.com/loop'))
    expect((await checkRedirectChain('https://www.youtube.com/loop')).ok).toBe(true)
    expect(calls.length).toBe(5)
  })
})
