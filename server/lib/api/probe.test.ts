import { describe, expect, test } from 'bun:test'
import { isCollectionUrl } from './collections'
import { estimateBytes, evaluateProbe, kinoPubSourceId, type ProbeInfo } from './probe'

const limits = { maxDurationSec: 1800, maxBytes: 524288000 }
const plain = { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ', kinoPub: false, playlistItemIndex: null, entryId: null }

const video: ProbeInfo = {
  _type: 'video',
  id: 'dQw4w9WgXcQ',
  title: 'Ролик',
  uploader: 'Автор',
  duration: 212,
  extractor: 'youtube',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  requested_formats: [
    { vcodec: 'avc1.4d401f', acodec: 'none', height: 720, filesize: 30_000_000 },
    { vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3_000_000 },
  ],
}

describe('проверка до скачивания', () => {
  test('обычный ролик проходит и даёт метаданные', () => {
    expect(evaluateProbe(video, limits, plain)).toEqual({
      ok: true,
      meta: {
        title: 'Ролик',
        uploader: 'Автор',
        durationSec: 212,
        extractor: 'youtube',
        sourceId: 'dQw4w9WgXcQ',
        webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    })
  })

  test('длиннее предела — too_long сразу', () => {
    expect(evaluateProbe({ ...video, duration: 1801 }, limits, plain)).toMatchObject({ ok: false, code: 'too_long' })
  })

  test('файл больше предела по filesize дорожек — too_large сразу', () => {
    const huge = { ...video, requested_formats: [{ vcodec: 'avc1', filesize: 600_000_000 }, { vcodec: 'none', filesize_approx: 1 }] }
    expect(evaluateProbe(huge, limits, plain)).toMatchObject({ ok: false, code: 'too_large' })
  })

  test('размер неизвестен — не повод отказать', () => {
    expect(estimateBytes({ vcodec: 'avc1' })).toBeNull()
    expect(evaluateProbe({ ...video, requested_formats: undefined }, limits, plain).ok).toBe(true)
  })

  test('эфир, анонс эфира и только что закончившийся эфир — live_stream', () => {
    for (const patch of [{ is_live: true }, { live_status: 'is_upcoming' }, { live_status: 'post_live' }]) {
      expect(evaluateProbe({ ...video, ...patch }, limits, plain)).toMatchObject({ ok: false, code: 'live_stream' })
    }
    expect(evaluateProbe({ ...video, live_status: 'was_live' }, limits, plain).ok).toBe(true)
  })

  test('только звук — no_video', () => {
    const audio = { ...video, requested_formats: undefined, vcodec: 'none', acodec: 'mp4a.40.2' }
    expect(evaluateProbe(audio, limits, plain)).toMatchObject({ ok: false, code: 'no_video' })
  })

  test('подборка без выбранного элемента — playlist_not_allowed', () => {
    const playlist: ProbeInfo = { _type: 'playlist', id: 'PL1', entries: [{ id: 'a' }, { id: 'b' }] }
    expect(evaluateProbe(playlist, limits, plain)).toMatchObject({ ok: false, code: 'playlist_not_allowed' })
  })

  test('подборка из одного ролика — это ролик', () => {
    const single: ProbeInfo = { _type: 'playlist', id: 'PL1', entries: [{ ...video }] }
    expect(evaluateProbe(single, limits, plain).ok).toBe(true)
  })

  test('элемент, указанный в ссылке (слайд Instagram), — можно, и проверяется он', () => {
    const carousel: ProbeInfo = { _type: 'playlist', id: 'C1', extractor: 'Instagram', entries: [{ id: 'a', duration: 10 }, { id: 'b', duration: 5000 }] }
    const context = { ...plain, sourceUrl: 'https://www.instagram.com/p/C1/?img_index=2', playlistItemIndex: 2 }
    expect(evaluateProbe(carousel, limits, context)).toMatchObject({ ok: false, code: 'too_long' })
    expect(evaluateProbe(carousel, limits, { ...context, playlistItemIndex: 1 })).toMatchObject({ ok: true, meta: { extractor: 'instagram', sourceId: 'a' } })
  })

  test('история, которой нет в подборке, — not_found', () => {
    const highlight: ProbeInfo = { _type: 'playlist', id: 'H1', entries: [{ id: 'a' }] }
    expect(evaluateProbe(highlight, limits, { ...plain, entryId: 'zzz' })).toMatchObject({ ok: false, code: 'not_found' })
  })

  test('kino.pub: id ролика со страницы, а не «master» с CDN', () => {
    const manifest: ProbeInfo = { _type: 'video', id: 'master', extractor: 'generic', duration: 5400, title: 'master' }
    const context = { ...plain, sourceUrl: 'https://kino.pub/item/view/12345/s2e7', kinoPub: true }
    const verdict = evaluateProbe(manifest, { ...limits, maxDurationSec: 10_000 }, context)
    expect(verdict).toMatchObject({ ok: true, meta: { extractor: 'kinopub', sourceId: '12345:s2e7', webpageUrl: context.sourceUrl } })
    expect(kinoPubSourceId('https://kino.pub/item/view/777')).toBe('777')
  })

  test('прямой манифест без площадки — устойчивый id по адресу', () => {
    const generic: ProbeInfo = { _type: 'video', id: 'index', extractor: 'generic', webpage_url: 'https://cdn.cdntogo.net/a/b/master.m3u8?token=1' }
    const again: ProbeInfo = { ...generic, webpage_url: 'https://cdn.cdntogo.net/a/b/master.m3u8?token=2' }
    const first = evaluateProbe(generic, limits, plain)
    const second = evaluateProbe(again, limits, plain)
    expect(first.ok && second.ok && first.meta.sourceId === second.meta.sourceId).toBe(true)
    expect(first.ok && first.meta.sourceId).not.toBe('index')
  })
})

describe('подборка видна по ссылке', () => {
  const collections = [
    'https://www.youtube.com/playlist?list=PL1',
    'https://www.youtube.com/@google',
    'https://www.youtube.com/channel/UC123',
    'https://m.youtube.com/c/name',
    'https://www.tiktok.com/@someone',
    'https://www.tiktok.com/tag/cats',
    'https://vk.com/video/playlist/-1_2',
    'https://vk.com/videos-77521',
    'https://rutube.ru/plst/123/',
    'https://rutube.ru/channel/123/',
  ]
  const videos = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.tiktok.com/@someone/video/7206382937372134662',
    'https://vm.tiktok.com/ZMabc/',
    'https://vk.com/videos-77521?z=video-77521_162222515%2Fclub77521',
    'https://vk.com/video-50883936_456244102',
    'https://vkvideo.ru/video-50883936_456244102',
    'https://rutube.ru/video/3eac3b4561676c17df9132a9a1e62e3e/',
    'https://www.instagram.com/reel/abc/',
    'https://kino.pub/item/view/1',
  ]

  for (const url of collections) test(`подборка: ${url}`, () => expect(isCollectionUrl(url)).toBe(true))
  for (const url of videos) test(`ролик: ${url}`, () => expect(isCollectionUrl(url)).toBe(false))
})
