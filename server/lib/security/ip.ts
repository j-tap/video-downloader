import net from 'net'

/**
 * Разбор IP-адреса в массив байт (4 для IPv4, 16 для IPv6).
 * Возвращает null, если строка не является валидным IP.
 */
export function parseIp(value: string): number[] | null {
  const address = value.replace(/^\[/, '').replace(/\]$/, '')

  if (net.isIPv4(address)) {
    return address.split('.').map((part) => Number.parseInt(part, 10))
  }

  if (net.isIPv6(address)) {
    return parseIpv6(address)
  }

  return null
}

function parseIpv6(address: string): number[] | null {
  // Zone id (fe80::1%eth0) для наших целей не нужен.
  let head = address.split('%')[0] || ''
  let trailingBytes: number[] = []

  // IPv4-mapped / IPv4-compatible хвост: ::ffff:1.2.3.4
  const embeddedV4 = head.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embeddedV4?.[1]) {
    const v4 = parseIp(embeddedV4[1])
    if (!v4) return null
    trailingBytes = v4
    // Отрезаем IPv4-часть вместе с разделяющим двоеточием,
    // но сохраняем "::" если оно оказалось в конце.
    head = head.slice(0, head.length - embeddedV4[1].length)
    head = head.endsWith('::') ? head : head.replace(/:$/, '')
  }

  const expectedGroups = 8 - trailingBytes.length / 2
  const doubleColonIndex = head.indexOf('::')
  let groups: string[]

  if (doubleColonIndex >= 0) {
    const left = head.slice(0, doubleColonIndex).split(':').filter(Boolean)
    const right = head.slice(doubleColonIndex + 2).split(':').filter(Boolean)
    const missing = expectedGroups - left.length - right.length
    if (missing < 0) return null
    groups = [...left, ...Array<string>(missing).fill('0'), ...right]
  } else {
    groups = head.split(':').filter(Boolean)
  }

  if (groups.length !== expectedGroups) return null

  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const parsed = Number.parseInt(group, 16)
    bytes.push((parsed >> 8) & 0xff, parsed & 0xff)
  }

  bytes.push(...trailingBytes)

  return bytes.length === 16 ? bytes : null
}

/**
 * Приватные / зарезервированные диапазоны, до которых внешний пользователь
 * не должен иметь возможности дотянуться через наш сервер.
 */
function isPrivateIpv4(bytes: number[]): boolean {
  const [a = 0, b = 0] = bytes

  if (a === 0) return true                                  // 0.0.0.0/8 "this network"
  if (a === 10) return true                                 // private
  if (a === 127) return true                                // loopback
  if (a === 100 && b >= 64 && b <= 127) return true         // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true                   // link-local (metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true          // private
  if (a === 192 && b === 168) return true                   // private
  if (a === 192 && b === 0) return true                     // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true       // 198.18.0.0/15 benchmarking
  if (a >= 224) return true                                 // multicast + reserved + broadcast

  return false
}

function isPrivateIpv6(bytes: number[]): boolean {
  const isAllZeroPrefix = (length: number) => bytes.slice(0, length).every((byte) => byte === 0)

  // ::/128 и ::1/128
  if (isAllZeroPrefix(15) && (bytes[15] === 0 || bytes[15] === 1)) return true

  // ::ffff:0:0/96 — IPv4-mapped
  if (isAllZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12))
  }

  // 64:ff9b::/96 — NAT64
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPrivateIpv4(bytes.slice(12))
  }

  // 2002::/16 — 6to4, внутри лежит IPv4
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(bytes.slice(2, 6))
  }

  // 100::/64 — discard-only
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && isAllZeroPrefix(2)) return true

  const first = bytes[0] ?? 0
  const second = bytes[1] ?? 0

  if ((first & 0xfe) === 0xfc) return true                  // fc00::/7 unique local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (first === 0xff) return true                            // ff00::/8 multicast

  return false
}

export function isPrivateIp(value: string): boolean {
  const bytes = parseIp(value)
  if (!bytes) return true // не смогли разобрать — считаем небезопасным
  return bytes.length === 4 ? isPrivateIpv4(bytes) : isPrivateIpv6(bytes)
}

export function isIpLiteral(value: string): boolean {
  return parseIp(value) !== null
}
