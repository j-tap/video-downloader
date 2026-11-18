/**
 * Подборки, которые видны по самой ссылке: канал, плейлист, профиль.
 * Договор просит отказывать на них сразу (`400 playlist_not_allowed`),
 * без похода на сайт. Что по ссылке не видно (карусель, подборка VK
 * без явного пути), отсекает проверка метаданных в задаче.
 */

export function isCollectionUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return false
  }

  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '')
  const pathname = url.pathname

  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    // Ссылка на ролик внутри плейлиста (`watch?v=…&list=…`) — это ролик.
    if (url.searchParams.get('v')) return false
    return /^\/(?:playlist|@[^/]+|channel\/|c\/|user\/|feed\/|results)/i.test(pathname)
  }

  if (host.endsWith('tiktok.com')) {
    if (/\/(?:video|photo)\/\d+/.test(pathname)) return false
    return /^\/(?:@[^/]+\/?$|tag\/|music\/|discover\/)/i.test(pathname)
  }

  if (host === 'vk.com' || host === 'vk.ru' || host.endsWith('vkvideo.ru')) {
    // vk.com/videos-1?z=video-1_2 — ролик, открытый поверх списка.
    if (/(?:^|\/)(?:video|clip)-?\d+_\d+/.test(url.searchParams.get('z') || '')) return false
    return /^\/(?:video\/playlist\/|videos-?\d+\/?$|video\/@)/i.test(pathname)
  }

  if (host === 'rutube.ru') {
    return /^\/(?:plst|channel|u|metainfo\/tv)\//i.test(pathname)
  }

  return false
}
