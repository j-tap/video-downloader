import { describe, expect, test } from 'bun:test'
import { expandInstagramShortLink, getInstagramSelection, pkToShortcode } from './instagramUrl'

const selection = (url: string) => getInstagramSelection(new URL(url))

describe('выбор элемента из карусели и подборки Instagram', () => {
  test('без параметров ничего не выбирается', () => {
    expect(selection('https://www.instagram.com/reel/DB0YWyzPdcX/?igsh=abc')).toEqual({
      playlistItemIndex: null,
      entryId: null,
    })
  })

  test('img_index задаёт слайд карусели', () => {
    expect(selection('https://www.instagram.com/p/BQ0eAlwhDrw/?img_index=3').playlistItemIndex).toBe(3)
  })

  test('мусор в img_index игнорируется', () => {
    for (const value of ['0', '-1', '2abc', '1e3', '9999', '']) {
      expect(selection(`https://www.instagram.com/p/BQ0eAlwhDrw/?img_index=${value}`).playlistItemIndex).toBeNull()
    }
  })

  test('story_media_id превращается в шорткод, которым yt-dlp называет историю', () => {
    expect(selection('https://www.instagram.com/stories/highlights/18090946048123978/?story_media_id=3570766765028588805_123').entryId)
      .toBe('DGN6XQ9TL0F')
  })

  test('story_media_id без userId тоже принимается, мусор — нет', () => {
    expect(selection('https://www.instagram.com/s/x?story_media_id=1455917492202657669').entryId).toBe('BQ0dT7RBFeF')
    expect(selection('https://www.instagram.com/s/x?story_media_id=abc_1').entryId).toBeNull()
  })
})

describe('pkToShortcode', () => {
  // Пара сверена с _pk_to_id из yt-dlp на слайде реальной карусели.
  test('совпадает с кодированием yt-dlp, в том числе за пределами 2^53', () => {
    expect(pkToShortcode('1455917492202657669')).toBe('BQ0dT7RBFeF')
    expect(pkToShortcode('0')).toBe('A')
  })
})

describe('expandInstagramShortLink', () => {
  const highlightToken = Buffer.from('highlight:18090946048123978').toString('base64url')

  test('короткая ссылка /s/ разворачивается в адрес подборки', () => {
    const expanded = expandInstagramShortLink(new URL(`https://www.instagram.com/s/${highlightToken}?story_media_id=1_2`))
    expect(expanded.pathname).toBe('/stories/highlights/18090946048123978/')
    expect(expanded.searchParams.get('story_media_id')).toBe('1_2')
  })

  test('токен с паддингом из стандартного base64 тоже понимается', () => {
    const padded = Buffer.from('highlight:1').toString('base64')
    expect(padded.endsWith('=')).toBe(true)
    expect(expandInstagramShortLink(new URL(`https://www.instagram.com/s/${padded}`)).pathname)
      .toBe('/stories/highlights/1/')
  })

  test('прочие ссылки не трогаются', () => {
    for (const url of [
      'https://www.instagram.com/reel/DB0YWyzPdcX/',
      `https://www.instagram.com/s/${Buffer.from('user:123').toString('base64url')}`,
      'https://www.instagram.com/s/',
    ]) {
      expect(expandInstagramShortLink(new URL(url)).toString()).toBe(url)
    }
  })
})
