/**
 * Машинные коды ошибок — общие для API (договор с Todi, docs/video-links.md
 * в репозитории childs-games) и для сайта: сайт строит свой текст из кода.
 *
 * `retryable` обязан совпадать со столбцом «повтор» договора: по нему Todi
 * решает, повторять ли задачу самой.
 */

export const ERROR_CODES = {
  url_invalid: { status: 400, retryable: false },
  site_unsupported: { status: 400, retryable: false },
  playlist_not_allowed: { status: 400, retryable: false },
  no_video: { status: 422, retryable: false },
  live_stream: { status: 422, retryable: false },
  private: { status: 422, retryable: false },
  not_found: { status: 422, retryable: false },
  geo_blocked: { status: 422, retryable: false },
  drm: { status: 422, retryable: false },
  too_long: { status: 422, retryable: false },
  too_large: { status: 422, retryable: false },
  source_unreachable: { status: 502, retryable: true },
  processing_failed: { status: 500, retryable: true },
  timeout: { status: 504, retryable: true },
  queue_full: { status: 503, retryable: true },
  rate_limited: { status: 429, retryable: true },
  unauthorized: { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  job_not_found: { status: 404, retryable: true },
  file_expired: { status: 410, retryable: true },
  internal: { status: 500, retryable: true },
  cancelled: { status: 409, retryable: false },
  // Ниже — коды из разделов о запросах договора, которых нет в его таблице.
  not_ready: { status: 409, retryable: true },
  no_thumbnail: { status: 404, retryable: false },
  // В договоре нет кода для неразборчивого запроса (не JSON, лимит строкой).
  // Это ошибка программы клиента, а не ссылки, — повторять бессмысленно.
  bad_request: { status: 400, retryable: false },
} as const satisfies Record<string, { status: number; retryable: boolean }>

export type ErrorCode = keyof typeof ERROR_CODES

/**
 * Уточнение кода, которое нужно только сайту: у него на эти случаи свои,
 * более точные тексты. В API уходит только код.
 */
export type ErrorReason = 'bot_check' | 'story_missing' | 'trailer_only' | 'bad_file'

export interface Classified {
  code: ErrorCode
  reason?: ErrorReason
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CODES, value)
}

interface Rule {
  test: RegExp
  code: ErrorCode
  reason?: ErrorReason
}

/**
 * Порядок важен: первое совпадение побеждает. Сообщения yt-dlp складываются
 * из нескольких частей («Video unavailable. The uploader has not made this
 * video available in your country»), поэтому частное стоит раньше общего.
 */
const RULES: Rule[] = [
  { test: /only trailer stream/i, code: 'private', reason: 'trailer_only' },
  { test: /\bDRM\b|Widevine|protected content|copyright protection/i, code: 'drm' },
  { test: /live event will begin|This live event|Premieres? in \d|Premiere will begin|is a live stream|is currently live|live stream recording is not available|Waiting for (?:the )?(?:live|stream)/i, code: 'live_stream' },
  { test: /geo.?restrict|not available (?:in|from) your (?:country|location|region)|available in your country|available from your location|IP address is blocked|blocked (?:it )?in your country|in your region/i, code: 'geo_blocked' },
  // Проверка на бота — отказ адресу сервера, а не ролику: с другого выхода
  // он скачается. До `private`: в её тексте тоже есть «Sign in» и «--cookies».
  { test: /not a bot|confirm you.?re not/i, code: 'source_unreachable', reason: 'bot_check' },
  { test: /Private video|video is private|is private|confirm your age|age.?restrict|inappropriate for some users|members.only|Join this channel|login required|log ?in to|sign in to|Please sign in|requires? (?:authentication|login|a login)|empty media response|registered users|Access (?:denied|restricted)|cookies for the authentication|need to log ?in|You must log ?in/i, code: 'private' },
  { test: /try again later|rate.?limit|Too Many Requests|HTTP Error 429/i, code: 'source_unreachable' },
  // Фильтр с id ставится только при выборе истории из подборки, а истории
  // в разы короче лимита — значит, не нашлась сама история.
  { test: /does not pass filter \([^)]*\bid=/i, code: 'not_found', reason: 'story_missing' },
  { test: /larger than max-filesize|File is larger than/i, code: 'too_large' },
  { test: /does not pass filter/i, code: 'too_long' },
  { test: /File not found after download|Unable to read downloaded file|Downloaded file is empty/i, code: 'internal', reason: 'bad_file' },
  // Сломанная установка, а не ролик: раньше общего «not found».
  { test: /(?:ffmpeg|ffprobe)(?: and ffmpeg)? (?:is )?not found/i, code: 'processing_failed' },
  { test: /There is no video|no video in this|does not contain (?:a )?video|No video formats found|This post does not have a video/i, code: 'no_video' },
  { test: /HTTP Error 404|video is unavailable|Video unavailable|has been (?:removed|deleted)|no longer available|does not exist|not found|has been terminated|was deleted|Video not available|Video source unavailable|post is unavailable|This content isn.?t available/i, code: 'not_found' },
  { test: /Unsupported URL|is not a valid URL|Invalid URL/i, code: 'url_invalid' },
  { test: /Postprocessing|ffmpeg|ffprobe|Conversion failed|Error opening output|Invalid data found|Merging .* failed/i, code: 'processing_failed' },
  { test: /Connection refused|timed out|Failed to establish|Temporary failure in name resolution|Name or service not known|nodename nor servname|Unable to connect|Connection (?:reset|aborted)|Remote end closed|RemoteDisconnected|Network is unreachable|IncompleteRead|ProxyError|Tunnel connection failed|SSL|HTTP Error (?:5\d\d|403)|Unable to download|giving up after/i, code: 'source_unreachable' },
]

/**
 * Код по выводу yt-dlp (и наших обёрток вокруг него). Площадка нужна для
 * одного исключения: YouTube «No video formats found» отдаёт, когда не пустил
 * сервер (PO Token, клиент), а не когда в ролике нет видео.
 */
export function classifyYtDlpOutput(output: string, options: { youtube?: boolean } = {}): Classified {
  for (const rule of RULES) {
    if (!rule.test.test(output)) continue

    if (rule.code === 'no_video' && options.youtube) {
      return { code: 'source_unreachable' }
    }

    return rule.reason ? { code: rule.code, reason: rule.reason } : { code: rule.code }
  }

  return { code: 'internal' }
}
