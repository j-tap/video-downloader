/**
 * Журнал API — JSON-строки в stdout, их собирает docker. Поля и события —
 * из раздела «Журнал» договора с Todi: `ts`, `level`, `event`, `requestId`,
 * `jobId`, `key` (имя), `host`, `code`, `elapsedMs`.
 *
 * Секрет ключа, заголовок Authorization и cookies сюда не попадают никогда:
 * в поля кладём только то, что передали явно, а хвост вывода yt-dlp
 * проходит через `redact`.
 */

export type LogLevel = 'info' | 'warn' | 'error'

type Sink = (line: string) => void

let sink: Sink = (line) => process.stdout.write(`${line}\n`)

/** Для тестов: перехватить строки журнала. Возвращает прежний приёмник. */
export function setLogSink(next: Sink): Sink {
  const previous = sink
  sink = next
  return previous
}

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, event }

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value
  }

  sink(JSON.stringify(line))
}

const TAIL_BYTES = 4096

/** Последние 4 КБ вывода — для `job.failed`. Режем по байтам, не по символам. */
export function outputTail(output: string): string {
  const cleaned = redact(output.trim())
  const bytes = Buffer.from(cleaned, 'utf8')
  if (bytes.length <= TAIL_BYTES) return cleaned

  // Начало могло попасть в середину многобайтного символа — его отбрасываем.
  return bytes.subarray(bytes.length - TAIL_BYTES).toString('utf8').replace(/^�+/, '')
}

/**
 * yt-dlp печатает адреса прокси и заголовки в отладочном выводе; логин
 * и пароль прокси, cookies и Authorization вычищаем на всякий случай.
 */
export function redact(text: string): string {
  return text
    .replace(/(\/\/)[^/@\s]*@/g, '$1***@')
    .replace(/(authorization|cookie|set-cookie)(["']?\s*[:=]\s*["']?)[^\n"']*/gi, '$1$2***')
}
