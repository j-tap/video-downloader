import { describe, expect, test } from 'bun:test'
import { getProxyChain, isProxyFailure, maskProxy, maskProxyArgs } from './proxy'

/**
 * YouTube пускает сервер только через чужой выход, а остальные площадки
 * не должны тратить на него канал. Цепочка нужна, чтобы при отказе одного
 * выхода загрузка шла через следующий, а не падала.
 */
describe('getProxyChain', () => {
  test('без настроек — напрямую', () => {
    expect(getProxyChain('youtube', {})).toEqual([null])
    expect(getProxyChain(null, {})).toEqual([null])
  })

  test('прокси площадки не уезжает на другие площадки', () => {
    const env = { YT_PROXY: 'http://vpn-proxy:8888' }
    expect(getProxyChain('youtube', env)).toEqual(['http://vpn-proxy:8888'])
    expect(getProxyChain('instagram', env)).toEqual([null])
    expect(getProxyChain('kino.pub', env)).toEqual([null])
    expect(getProxyChain(null, env)).toEqual([null])
  })

  test('PROXY — общий выход, прокси площадки его перекрывает', () => {
    const env = { PROXY: 'socks5://warp:1080', YT_PROXY: 'http://vpn-proxy:8888' }
    expect(getProxyChain('youtube', env)).toEqual(['http://vpn-proxy:8888'])
    expect(getProxyChain('facebook', env)).toEqual(['socks5://warp:1080'])
    expect(getProxyChain(null, env)).toEqual(['socks5://warp:1080'])
  })

  test('список пробуется по порядку, direct — без прокси', () => {
    const env = { YT_PROXY: ' http://vpn-proxy:8888 , socks5://warp:1080,DIRECT ,' }
    expect(getProxyChain('youtube', env)).toEqual(['http://vpn-proxy:8888', 'socks5://warp:1080', null])
  })

  test('пустая переменная площадки не отключает общий PROXY', () => {
    expect(getProxyChain('youtube', { YT_PROXY: '  ', PROXY: 'http://p:1' })).toEqual(['http://p:1'])
  })
})

describe('маскировка', () => {
  test('логин и пароль не попадают в лог', () => {
    expect(maskProxy('http://user:secret@proxy.example:8000')).toBe('http://***@proxy.example:8000')
    expect(maskProxy('http://vpn-proxy:8888')).toBe('http://vpn-proxy:8888')
    expect(maskProxy(null)).toBe('direct')
  })

  test('в аргументах маскируется только значение --proxy', () => {
    const args = ['--proxy', 'socks5://u:p@h:1', '-o', 'user:pass@file', 'https://youtu.be/x']
    expect(maskProxyArgs(args)).toEqual(['--proxy', 'socks5://***@h:1', '-o', 'user:pass@file', 'https://youtu.be/x'])
  })
})

describe('isProxyFailure', () => {
  // Строки — из настоящего вывода yt-dlp.
  test('мёртвый или ненайденный прокси — смена выхода', () => {
    expect(isProxyFailure(`ERROR: [youtube] x: Unable to download API page: ('Unable to connect to proxy', NewConnectionError("HTTPSConnection(host='127.0.0.1', port=1): Failed to establish a new connection: [Errno 111] Connection refused"))`)).toBe(true)
    expect(isProxyFailure(`ERROR: [youtube] x: Unable to download API page: ('Unable to connect to proxy', NameResolutionError("Failed to resolve 'vpn-proxy' ([Errno -2] Name or service not known)")) (caused by ProxyError(`)).toBe(true)
    expect(isProxyFailure('ERROR: Unable to download webpage: Tunnel connection failed: 503 Service Unavailable')).toBe(true)
  })

  test('отказ YouTube — не повод уходить с выхода', () => {
    expect(isProxyFailure('ERROR: unable to download video data: HTTP Error 403: Forbidden')).toBe(false)
    expect(isProxyFailure("ERROR: [youtube] x: Sign in to confirm you're not a bot.")).toBe(false)
    expect(isProxyFailure('ERROR: [youtube] x: Video unavailable')).toBe(false)
  })
})
