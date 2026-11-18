import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { runCapture } from '../process'

/**
 * Готовый файл по договору: mp4, H.264 + AAC, `moov` в начале, высота
 * не больше заказанной. yt-dlp выбирает подходящие дорожки, но не у каждого
 * источника они есть, поэтому последнее слово за ffmpeg: годное — только
 * перепаковать с faststart, негодное — перекодировать (`veryfast`).
 */

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'

export interface MediaInfo {
  videoCodec: string
  pixFmt: string | null
  audioCodec: string | null
  /** Как видит зритель: с учётом поворота из метаданных телефона */
  width: number
  height: number
  durationSec: number
}

export type FinalizeResult =
  | { ok: true; info: MediaInfo; transcoded: boolean }
  | { ok: false; code: 'no_video' | 'processing_failed'; output: string }

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  duration?: string
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number }>
  disposition?: { attached_pic?: number }
}

export async function probeMedia(file: string, signal?: AbortSignal): Promise<MediaInfo | null> {
  const result = await runCapture(FFPROBE_BIN, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ], { signal, timeoutMs: 60_000 })

  if (result.code !== 0) return null

  let parsed: { streams?: ProbeStream[]; format?: { duration?: string } }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return null
  }

  const streams = parsed.streams ?? []
  // Обложка внутри mp4 — тоже «видеопоток» (attached_pic); это не ролик.
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (!video?.codec_name || !video.width || !video.height) return null

  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const rotation = Math.abs(Number(video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180
  const rotated = rotation === 90

  return {
    videoCodec: video.codec_name,
    pixFmt: video.pix_fmt ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    durationSec: Number.parseFloat(parsed.format?.duration ?? video.duration ?? '0') || 0,
  }
}

/** Решение без запуска ffmpeg — отдельно, чтобы его можно было проверить тестом. */
export function planFinalize(info: MediaInfo, maxHeight: number): { copyVideo: boolean; copyAudio: boolean } {
  const copyVideo = info.videoCodec === 'h264'
    && (info.pixFmt === null || info.pixFmt === 'yuv420p' || info.pixFmt === 'yuvj420p')
    && info.height <= maxHeight
  const copyAudio = info.audioCodec === null || info.audioCodec === 'aac'
  return { copyVideo, copyAudio }
}

export function buildFinalizeArgs(source: string, target: string, plan: { copyVideo: boolean; copyAudio: boolean }, maxHeight: number): string[] {
  const video = plan.copyVideo
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        // Ширина подбирается по пропорции и чётная — иначе yuv420p не собрать.
        '-vf', `scale=-2:'min(${maxHeight},trunc(ih/2)*2)'`,
      ]

  const audio = plan.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']

  return [
    '-hide_banner', '-nostdin', '-y',
    '-v', 'error',
    '-i', source,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn', '-dn',
    ...video,
    ...audio,
    // Без этого плеер не начнёт показ, пока не скачает файл целиком.
    '-movflags', '+faststart',
    '-f', 'mp4',
    target,
  ]
}

export async function finalizeVideo(source: string, target: string, maxHeight: number, signal: AbortSignal): Promise<FinalizeResult> {
  const info = await probeMedia(source, signal)
  if (!info) {
    return { ok: false, code: 'no_video', output: 'ffprobe: no video stream in downloaded file' }
  }

  const plan = planFinalize(info, maxHeight)
  const temporary = `${target}.tmp`
  const result = await runCapture(FFMPEG_BIN, buildFinalizeArgs(source, temporary, plan, maxHeight), { signal, maxStderr: 64 * 1024 })

  if (result.code !== 0 || signal.aborted) {
    fs.rmSync(temporary, { force: true })
    return { ok: false, code: 'processing_failed', output: `ffmpeg exited with ${result.code}\n${result.stderr}` }
  }

  fs.renameSync(temporary, target)

  const final = await probeMedia(target, signal)
  if (!final || final.videoCodec !== 'h264' || (final.audioCodec !== null && final.audioCodec !== 'aac') || final.height > maxHeight) {
    return { ok: false, code: 'processing_failed', output: `ffmpeg produced unexpected file: ${JSON.stringify(final)}` }
  }

  return { ok: true, info: final, transcoded: !plan.copyVideo || !plan.copyAudio }
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const THUMBNAIL_MAX_BYTES = 500 * 1024
const THUMBNAIL_MAX_WIDTH = 1280

/** Ширина и качество JPEG по нарастающей компрессии — первое, что влезло в 500 КБ. */
const THUMBNAIL_STEPS: Array<[number, number]> = [
  [THUMBNAIL_MAX_WIDTH, 3],
  [THUMBNAIL_MAX_WIDTH, 6],
  [THUMBNAIL_MAX_WIDTH, 10],
  [960, 8],
  [640, 8],
  [640, 15],
]

/**
 * Обложка yt-dlp приходит в webp, png или jpg любого размера. Приводим её
 * к jpeg ≤ 1280 по ширине и ≤ 500 КБ. Не вышло — без обложки: это не ошибка.
 */
export async function makeThumbnail(source: string, target: string, signal: AbortSignal): Promise<boolean> {
  const temporary = `${target}.tmp.jpg`

  for (const [width, quality] of THUMBNAIL_STEPS) {
    const result = await runCapture(FFMPEG_BIN, [
      '-hide_banner', '-nostdin', '-y',
      '-v', 'error',
      '-i', source,
      '-frames:v', '1',
      '-vf', `scale='min(${width},iw)':-2`,
      '-pix_fmt', 'yuvj420p',
      '-q:v', String(quality),
      '-f', 'image2',
      '-update', '1',
      temporary,
    ], { signal, timeoutMs: 60_000 })

    if (result.code !== 0 || signal.aborted) break

    const size = fs.statSync(temporary, { throwIfNoEntry: false })?.size ?? 0
    if (size > 0 && size <= THUMBNAIL_MAX_BYTES) {
      fs.renameSync(temporary, target)
      return true
    }
  }

  fs.rmSync(temporary, { force: true })
  return false
}

/** Обложку yt-dlp называет по шаблону `thumb.%(ext)s` — расширение заранее неизвестно. */
export function findThumbnailSource(dir: string): string | null {
  try {
    const name = fs.readdirSync(dir).find((candidate) => /^thumb\.(?:jpe?g|png|webp|gif|image)$/i.test(candidate))
    return name ? path.join(dir, name) : null
  } catch {
    return null
  }
}
