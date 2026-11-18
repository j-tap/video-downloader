import fs from 'fs'
import path from 'path'
import {
  buildProbeArgs,
  buildYtDlpArgs,
  getItemSelection,
  isKinoPub,
  isYouTube,
  normalizeUrl,
  planNextAttempt,
  resolveDownloadTarget,
  YTDLP_BIN,
  type AttemptContext,
  type DownloadProfile,
} from '../downloader'
import { classifyYtDlpOutput, type ErrorCode } from '../errorCodes'
import { runCapture } from '../process'
import { dirBytes, THUMBNAIL_FILE, VIDEO_FILE, type JobFiles } from './files'
import { finalizeVideo, findThumbnailSource, makeThumbnail, sha256File } from './media'
import { evaluateProbe, type ProbeInfo } from './probe'
import type { ExecHooks, ExecResult, Executor } from './queue'
import type { JobRecord } from './store'

/**
 * Одна задача API от ссылки до готового файла:
 * метаданные → проверка пределов → загрузка → mp4 по договору → sha256 и обложка.
 *
 * Повторы те же, что у сайта (planNextAttempt): другой выход, без cookies,
 * другой клиент YouTube. Метаданные читаются с теми же повторами, и загрузка
 * продолжает с той попытки, на которой метаданные прочитались.
 */

const PROBE_TIMEOUT_MS = 3 * 60_000
const SIZE_CHECK_INTERVAL_MS = 5000
const SOURCE_PREFIX = 'source.'
const META_FILE = 'meta.json'
const COOKIES_FILE = 'cookies.txt'
/** Длительность контейнера после склейки дорожек гуляет на доли секунды — небольшой допуск. */
const DURATION_TOLERANCE_SEC = 2

/** Пределы договора для формата: высота и H.264 первым; ffmpeg доводит остальное. */
export function apiFormatArgs(maxHeight: number): string[] {
  return [
    '-f', `bv*[height<=?${maxHeight}]+ba/b[height<=?${maxHeight}]/bv*+ba/b`,
    // res — разрешение по меньшей стороне; среди равных — H.264 и AAC,
    // чтобы перекодирование понадобилось как можно реже.
    '-S', 'res,vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4',
  ]
}

export function createPipelineExecutor(files: JobFiles): Executor {
  return (job, hooks, signal) => runPipeline(job, files, hooks, signal)
}

async function runPipeline(job: JobRecord, files: JobFiles, hooks: ExecHooks, signal: AbortSignal): Promise<ExecResult> {
  const dir = files.prepare(job.id)
  const cookiesPath = path.join(dir, COOKIES_FILE)

  try {
    return await download(job, dir, cookiesPath, hooks, signal)
  } finally {
    // Копия cookies владельца не должна лежать на томе дольше загрузки.
    fs.rmSync(cookiesPath, { force: true })
  }
}

async function download(job: JobRecord, dir: string, cookiesPath: string, hooks: ExecHooks, signal: AbortSignal): Promise<ExecResult> {
  const sourceUrl = job.url
  const youtube = isYouTube(sourceUrl)
  const kinoPub = isKinoPub(sourceUrl)
  const selection = getItemSelection(sourceUrl)

  const target = await resolveDownloadTarget(normalizeUrl(sourceUrl), job.id, cookiesPath)
  if (signal.aborted) return aborted()
  if (target.trailerOnly) {
    return { ok: false, code: 'private', output: 'kino.pub returned only trailer stream for this page' }
  }

  let ctx: AttemptContext = {
    url: target.url,
    attempt: 0,
    proxyIndex: 0,
    useCookies: true,
    playlistItemIndex: target.playlistItemIndex ?? selection.playlistItemIndex,
    entryId: selection.entryId,
  }

  const profile: DownloadProfile = {
    maxBytes: job.maxBytes,
    maxDurationSec: job.maxDurationSec,
    formatArgs: apiFormatArgs(job.maxHeight),
    extraArgs: ['--write-thumbnail', '-o', `thumbnail:${path.join(dir, 'thumb.%(ext)s')}`],
    metaPath: path.join(dir, META_FILE),
    metaTemplate: 'after_move:%(.{extractor,id,title})j',
    cookiesPath,
  }

  // 1. Метаданные и проверка до скачивания.
  let info: ProbeInfo | null = null
  for (;;) {
    const result = await runCapture(YTDLP_BIN, buildProbeArgs(ctx.url, job.id, ctx, profile), {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (signal.aborted) return aborted()

    if (result.code === 0) {
      info = parseJson(result.stdout)
      if (info) break
    }

    const output = result.stderr || `yt-dlp probe exited with ${result.code}`
    const plan = planNextAttempt(output, ctx, sourceUrl)
    if (!plan) return failFromOutput(output, result.code, youtube)

    hooks.log('info', 'job.retry', { stage: 'probe', reason: plan.reason })
    ctx = plan.ctx
  }

  const verdict = evaluateProbe(info, job, {
    sourceUrl,
    kinoPub,
    playlistItemIndex: ctx.playlistItemIndex,
    entryId: ctx.entryId,
  })
  if (!verdict.ok) return { ok: false, code: verdict.code, output: verdict.detail }
  hooks.setMeta(verdict.meta)

  // 2. Загрузка.
  let source: string | null = null
  for (;;) {
    const attempt = await runDownloadAttempt(job, dir, ctx, profile, hooks, signal)
    if (signal.aborted) return aborted()
    if (attempt.tooLarge) return { ok: false, code: 'too_large', output: `downloaded more than ${job.maxBytes} bytes` }

    // Некоторые экстракторы выходят с ошибкой из-за побочных элементов
    // подборки, хотя нужный файл уже скачан, — поэтому сначала файл.
    source = findSourceFile(dir)
    if (source) break

    const output = attempt.output || 'File not found after download'
    const plan = planNextAttempt(output, ctx, sourceUrl)
    if (!plan) return failFromOutput(output, attempt.code, youtube)

    hooks.log('info', 'job.retry', { stage: 'download', reason: plan.reason })
    ctx = plan.ctx
  }

  // 3. Файл по договору.
  hooks.setStatus('processing')
  const videoPath = path.join(dir, VIDEO_FILE)
  const finalized = await finalizeVideo(source, videoPath, job.maxHeight, signal)
  if (signal.aborted) return aborted()
  fs.rmSync(source, { force: true })
  if (!finalized.ok) return { ok: false, code: finalized.code, output: finalized.output }

  const sizeBytes = fs.statSync(videoPath).size
  if (sizeBytes > job.maxBytes) {
    return { ok: false, code: 'too_large', output: `final file ${sizeBytes} bytes > ${job.maxBytes}` }
  }

  // Длительность могла быть неизвестна до загрузки (прямые манифесты).
  if (finalized.info.durationSec > job.maxDurationSec + DURATION_TOLERANCE_SEC) {
    return { ok: false, code: 'too_long', output: `final duration ${finalized.info.durationSec}s > ${job.maxDurationSec}s` }
  }

  const sha256 = await sha256File(videoPath)

  const thumbnailSource = findThumbnailSource(dir)
  const hasThumbnail = thumbnailSource
    ? await makeThumbnail(thumbnailSource, path.join(dir, THUMBNAIL_FILE), signal)
    : false
  if (thumbnailSource) fs.rmSync(thumbnailSource, { force: true })
  fs.rmSync(path.join(dir, META_FILE), { force: true })
  if (signal.aborted) return aborted()

  return {
    ok: true,
    file: {
      sizeBytes,
      sha256,
      width: finalized.info.width,
      height: finalized.info.height,
      durationSec: Math.round(finalized.info.durationSec),
      hasThumbnail,
    },
  }
}

interface AttemptResult {
  code: number | null
  output: string
  tooLarge: boolean
}

async function runDownloadAttempt(
  job: JobRecord,
  dir: string,
  ctx: AttemptContext,
  profile: DownloadProfile,
  hooks: ExecHooks,
  signal: AbortSignal,
): Promise<AttemptResult> {
  // --max-filesize не работает для HLS и фрагментов: размер сторожим сами.
  const local = new AbortController()
  const combined = AbortSignal.any([signal, local.signal])
  let tooLarge = false

  const watchdog = setInterval(() => {
    const bytes = dirBytes(dir, (name) => name.startsWith(SOURCE_PREFIX))
    if (bytes > job.maxBytes) {
      tooLarge = true
      local.abort()
    }
  }, SIZE_CHECK_INTERVAL_MS)
  watchdog.unref?.()

  // yt-dlp сообщает о срабатывании --max-filesize и --match-filter в stdout
  // и выходит с кодом 0 — такие строки нужны для разбора причины.
  const notices: string[] = []

  const result = await runCapture(
    YTDLP_BIN,
    buildYtDlpArgs(ctx.url, path.join(dir, `${SOURCE_PREFIX}%(ext)s`), job.id, ctx, profile),
    {
      signal: combined,
      discardStdout: true,
      onLine: (line) => {
        const progress = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/)
        if (progress?.[1]) hooks.setProgress(Number.parseFloat(progress[1]))
        if (/larger than max-filesize|does not pass filter/i.test(line)) notices.push(line)
      },
    },
  )

  clearInterval(watchdog)

  return {
    code: result.code,
    output: [result.stderr.trim(), ...notices].filter(Boolean).join('\n'),
    tooLarge,
  }
}

/** Скачанный файл: `source.<ext>`, кроме недокачанных частей и отдельных дорожек. */
export function findSourceFile(dir: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }

  const candidates = names
    .filter((name) => name.startsWith(SOURCE_PREFIX))
    .filter((name) => !/\.(?:part|ytdl|temp)$/i.test(name) && !/\.part-Frag\d+/i.test(name))
    // source.f137.mp4 — дорожка до склейки: только видео или только звук.
    .filter((name) => !/\.f[\w-]+\.\w+$/.test(name.slice(SOURCE_PREFIX.length - 1)))
    .map((name) => path.join(dir, name))
    .filter((file) => (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0)

  if (candidates.length === 0) return null
  candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
  return candidates[0] ?? null
}

function failFromOutput(output: string, exitCode: number | null, youtube: boolean): ExecResult {
  const { code } = classifyYtDlpOutput(output, { youtube })
  return { ok: false, code, output, exitCode }
}

function aborted(): ExecResult {
  // Итог остановленной задачи решает очередь по причине остановки.
  return { ok: false, code: 'cancelled' satisfies ErrorCode }
}

function parseJson(text: string): ProbeInfo | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as ProbeInfo : null
  } catch {
    return null
  }
}
