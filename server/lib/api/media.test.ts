import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildFinalizeArgs, finalizeVideo, makeThumbnail, planFinalize, probeMedia, sha256File } from './media'

describe('что делать с файлом', () => {
  const h264 = { videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', width: 1280, height: 720, durationSec: 10 }

  test('H.264 + AAC нужной высоты — только перепаковка с faststart', () => {
    const plan = planFinalize(h264, 720)
    expect(plan).toEqual({ copyVideo: true, copyAudio: true })
    const args = buildFinalizeArgs('in', 'out', plan, 720)
    expect(args).toContain('+faststart')
    expect(args.join(' ')).toContain('-c:v copy')
    expect(args.join(' ')).not.toContain('libx264')
  })

  test('выше предела, VP9, 10 бит — перекодировать veryfast', () => {
    expect(planFinalize({ ...h264, height: 1080 }, 720).copyVideo).toBe(false)
    expect(planFinalize({ ...h264, videoCodec: 'vp9' }, 720).copyVideo).toBe(false)
    expect(planFinalize({ ...h264, pixFmt: 'yuv420p10le' }, 720).copyVideo).toBe(false)
    const args = buildFinalizeArgs('in', 'out', { copyVideo: false, copyAudio: false }, 720).join(' ')
    expect(args).toContain('-preset veryfast')
    expect(args).toContain('min(720')
    expect(args).toContain('-c:a aac')
  })

  test('Opus — звук перекодировать, видео оставить', () => {
    expect(planFinalize({ ...h264, audioCodec: 'opus' }, 720)).toEqual({ copyVideo: true, copyAudio: false })
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

/**
 * Настоящий ffmpeg на синтетическом ролике: не H.264 (MPEG-4 Part 2 — кодируется
 * быстро), звук Opus, 960 по высоте — всё приходится переделывать.
 * Без ffmpeg тест пропускается.
 */
describe.skipIf(!hasFfmpeg)('ffmpeg: mp4 по договору', () => {
  let dir = ''

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-media-test-'))
    const made = spawnSync('ffmpeg', [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x960:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'mpeg4', '-q:v', '10',
      '-c:a', 'libopus',
      path.join(dir, 'source.mkv'),
    ])
    if (made.status !== 0) throw new Error(made.stderr.toString())

    spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160', '-frames:v', '1', path.join(dir, 'thumb.png')])
  }, 60_000)

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('перекодирует в H.264 + AAC ≤ 720 с moov в начале', async () => {
    const target = path.join(dir, 'video.mp4')
    const result = await finalizeVideo(path.join(dir, 'source.mkv'), target, 720, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, transcoded: true })
    const info = await probeMedia(target)
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', height: 720, width: 960 })

    const head = fs.readFileSync(target).subarray(0, 64 * 1024)
    expect(head.subarray(4, 8).toString('latin1')).toBe('ftyp')
    const moov = head.indexOf('moov')
    const mdat = head.indexOf('mdat')
    expect(moov).toBeGreaterThan(0)
    expect(mdat === -1 || moov < mdat).toBe(true)

    expect(await sha256File(target)).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  test('обложка 4K → jpeg ≤ 1280 по ширине и ≤ 500 КБ', async () => {
    const target = path.join(dir, 'thumbnail.jpg')
    expect(await makeThumbnail(path.join(dir, 'thumb.png'), target, new AbortController().signal)).toBe(true)
    expect(fs.statSync(target).size).toBeLessThanOrEqual(500 * 1024)
    const info = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,codec_name', '-of', 'csv=p=0', target]).stdout.toString().trim()
    expect(info).toBe('mjpeg,1280')
  })

  test('файл без видео — no_video', async () => {
    const audio = path.join(dir, 'audio.m4a')
    spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', audio])
    const result = await finalizeVideo(audio, path.join(dir, 'x.mp4'), 720, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, code: 'no_video' })
  })
})
