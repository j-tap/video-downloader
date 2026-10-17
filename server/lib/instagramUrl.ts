/**
 * Какой элемент нужен из того, что yt-dlp вернёт плейлистом.
 *
 * Карусель и хайлайт Instagram yt-dlp отдаёт плейлистом даже с --no-playlist,
 * а мы пишем всё в один файл: первый элемент занимает его, остальные
 * пропускаются как «уже скачанные». Пользователь получал первый слайд поста
 * или самую старую историю подборки вместо той, что открыл. Номер слайда
 * и id истории приходят в query-параметрах, а их мы вырезаем как трекинг, —
 * поэтому выбор достаём из исходной ссылки до нормализации.
 */
export interface ItemSelection {
  /** Номер элемента, начиная с 1: слайд карусели из ?img_index= */
  playlistItemIndex: number | null
  /** id элемента: история хайлайта из ?story_media_id= */
  entryId: string | null
}

export const NO_SELECTION: ItemSelection = { playlistItemIndex: null, entryId: null }

/** Алфавит шорткодов Instagram — тот же, что _ENCODING_CHARS в yt-dlp. */
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const MAX_PLAYLIST_ITEM = 100

export function getInstagramSelection(parsed: URL): ItemSelection {
  return {
    playlistItemIndex: parseImgIndex(parsed.searchParams.get('img_index')),
    entryId: parseStoryMediaId(parsed.searchParams.get('story_media_id')),
  }
}

function parseImgIndex(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null

  const index = Number.parseInt(value, 10)
  return index >= 1 && index <= MAX_PLAYLIST_ITEM ? index : null
}

/**
 * story_media_id имеет вид `<pk>_<userId>`, а yt-dlp называет элементы
 * шорткодом, то есть тем же pk в base64-подобной записи.
 */
function parseStoryMediaId(value: string | null): string | null {
  const pk = value?.match(/^(\d{1,25})(?:_\d+)?$/)?.[1]
  return pk ? pkToShortcode(pk) : null
}

export function pkToShortcode(pk: string): string {
  let value = BigInt(pk)
  if (value === 0n) return SHORTCODE_ALPHABET[0]!

  let shortcode = ''
  while (value > 0n) {
    shortcode = SHORTCODE_ALPHABET[Number(value % 64n)] + shortcode
    value /= 64n
  }

  return shortcode
}

/**
 * Короткая ссылка на историю из подборки: `/s/<base64 от "highlight:<id>">`.
 * yt-dlp её не знает и отдаёт generic-экстрактору, который зависит от
 * редиректа Instagram, а с браузерным User-Agent тот отвечает 200 без редиректа.
 * Разворачиваем сами в каноничный адрес подборки.
 */
export function expandInstagramShortLink(parsed: URL): URL {
  const token = parsed.pathname.match(/^\/s\/([A-Za-z0-9_-]+={0,2})\/?$/)?.[1]
  if (!token) return parsed

  const decoded = Buffer.from(token, 'base64url').toString('utf8')
  const highlightId = decoded.match(/^highlight:(\d+)$/)?.[1]
  if (!highlightId) return parsed

  const expanded = new URL(parsed.toString())
  expanded.pathname = `/stories/highlights/${highlightId}/`
  return expanded
}
