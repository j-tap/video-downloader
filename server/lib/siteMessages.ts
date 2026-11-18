import { formatBytes, formatDuration, limits } from './config'
import type { Classified } from './errorCodes'

/**
 * Текст ошибки для посетителя сайта — из того же кода, что уходит в API.
 * Уточнения (`reason`) нужны только сайту: у него на эти случаи свои слова.
 */
export function getSiteMessage({ code, reason }: Classified): string {
  switch (code) {
    case 'too_large':
      return `Видео больше лимита ${formatBytes(limits.maxDownloadBytes)}.`
    case 'too_long':
      return `Видео длиннее лимита в ${formatDuration(limits.maxDurationSeconds)}.`
    case 'drm':
      return 'Видео защищено DRM и не может быть скачано.'
    case 'live_stream':
      return 'Это прямой эфир. Скачать можно будет запись, когда он закончится.'
    case 'geo_blocked':
      return 'Источник не показывает это видео в стране, где стоит наш сервер.'
    case 'private':
      return reason === 'trailer_only'
        ? 'Для этой страницы доступен только трейлер.'
        : 'Источник не отдаёт это видео без авторизации.'
    case 'not_found':
      return reason === 'story_missing'
        ? 'Эта история не найдена в подборке — возможно, её уже удалили.'
        : 'Видео не найдено или ссылка не поддерживается.'
    case 'url_invalid':
    case 'site_unsupported':
      return 'Видео не найдено или ссылка не поддерживается.'
    case 'no_video':
      return 'По этой ссылке нет видео — только фото или текст.'
    case 'playlist_not_allowed':
      return 'Это ссылка на подборку, а нужна ссылка на одно видео.'
    case 'source_unreachable':
      // Проверка на бота — отказ серверу, а не видео: с домашнего IP та же
      // ссылка качается, поэтому посетителю важно знать, что дело не в нём.
      return reason === 'bot_check'
        ? 'YouTube сейчас не пускает наш сервер. Дело не в вашей ссылке — попробуйте позже.'
        : 'Не удалось связаться с источником. Попробуйте позже.'
    case 'processing_failed':
      return 'Не удалось обработать видео. Попробуйте ещё раз.'
    case 'internal':
      if (reason === 'bad_file') return 'Источник отдал некорректный файл. Попробуйте ещё раз.'
      break
  }

  return 'Не удалось скачать видео. Попробуйте позже или пришлите другую ссылку.'
}
