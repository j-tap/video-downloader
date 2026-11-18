import { describe, expect, test } from 'bun:test'
import { getProxyChain, maskProxy, maskProxyArgs } from './proxy'

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
