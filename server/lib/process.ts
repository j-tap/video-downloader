import { spawn } from 'child_process'

/**
 * Запуск внешней программы (yt-dlp, ffmpeg, ffprobe, curl) без блокировки
 * сервера. spawnSync на время работы останавливал весь event loop: пока
 * yt-dlp разбирал страницу, никто не получал даже статус своей загрузки.
 */

export interface ProcessResult {
  /** Код выхода; null — процесс убит сигналом */
  code: number | null
  stdout: string
  stderr: string
  /** Остановлен по signal или таймауту */
  aborted: boolean
}

export interface RunOptions {
  /** Отмена извне: SIGTERM, через 5 с — SIGKILL */
  signal?: AbortSignal
  timeoutMs?: number
  /** Сколько stdout держать целиком (JSON yt-dlp бывает в мегабайты) */
  maxBuffer?: number
  /** Сколько хвоста stderr держать (нужен для разбора причины) */
  maxStderr?: number
  /** Каждая строка stdout и stderr по мере появления (прогресс yt-dlp) */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Не копить stdout — когда он нужен только построчно */
  discardStdout?: boolean
}

const KILL_GRACE_MS = 5000

export function runCapture(bin: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  const {
    signal,
    timeoutMs,
    maxBuffer = 10 * 1024 * 1024,
    maxStderr = 256 * 1024,
    onLine,
    discardStdout = false,
  } = options

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let aborted = false
    let settled = false

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      aborted = true
      child.kill('SIGTERM')
      // ffmpeg под yt-dlp не всегда выходит по SIGTERM — добиваем.
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null
    timer?.unref?.()

    const onAbort = () => kill()
    if (signal) {
      if (signal.aborted) kill()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const lineSplitter = (stream: 'stdout' | 'stderr') => {
      let pending = ''
      return (chunk: string) => {
        if (!onLine) return
        pending += chunk
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line) onLine(line, stream)
      }
    }
    const splitStdout = lineSplitter('stdout')
    const splitStderr = lineSplitter('stderr')

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      if (!discardStdout && stdout.length < maxBuffer) stdout += chunk.slice(0, maxBuffer - stdout.length)
      splitStdout(chunk)
    })

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr)
      splitStderr(chunk)
    })

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, aborted })
    }

    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
