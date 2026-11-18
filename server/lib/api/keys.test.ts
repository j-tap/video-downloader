import { describe, expect, spyOn, test } from 'bun:test'
import crypto from 'crypto'
import { authenticate, loadKeyRing, parseKeyList } from './keys'

const SECRET = 'Zk3vQ9pX7rT2mW8yN4bC6dF1gH5jK0lA2sD4fG6hJ8k'
const OTHER = 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c'
const OLD = 'oLdKeYoLdKeYoLdKeYoLdKeYoLdKeYoLdKeYoLdKeY0'

describe('API_KEYS', () => {
  test('разбирает именованные ключи', () => {
    const { keys, problems } = parseKeyList(`todi:${SECRET}, other:${OTHER}`)
    expect(keys.map((key) => key.name)).toEqual(['todi', 'other'])
    expect(problems).toEqual([])
  })

  test('пустое значение — ни одного ключа', () => {
    expect(parseKeyList('').keys).toEqual([])
    expect(parseKeyList(undefined).keys).toEqual([])
  })

  test('сообщения о плохих элементах не содержат секрет', () => {
    const { keys, problems } = parseKeyList(`без-двоеточия${SECRET},todi:short,todi:${SECRET}`)
    expect(keys.map((key) => key.name)).toEqual(['todi'])
    expect(problems.join(' ')).not.toContain(SECRET)
    expect(problems.some((problem) => problem.includes('короче'))).toBe(true)
    expect(problems.some((problem) => problem.includes('дважды'))).toBe(true)
  })
})

describe('authenticate', () => {
  const { ring } = loadKeyRing({ API_KEYS: `todi:${SECRET},other:${OTHER}`, API_KEYS_REVOKED: `todi-old:${OLD}` })

  test('нет заголовка — unauthorized', () => {
    expect(authenticate(undefined, ring)).toEqual({ ok: false, code: 'unauthorized' })
  })

  test('не Bearer — unauthorized', () => {
    expect(authenticate(`Basic ${SECRET}`, ring)).toEqual({ ok: false, code: 'unauthorized' })
  })

  test('неверный ключ — unauthorized', () => {
    expect(authenticate('Bearer nope', ring)).toEqual({ ok: false, code: 'unauthorized' })
  })

  test('верный ключ — имя ключа', () => {
    expect(authenticate(`Bearer ${SECRET}`, ring)).toEqual({ ok: true, name: 'todi' })
    expect(authenticate(`bearer ${OTHER}`, ring)).toEqual({ ok: true, name: 'other' })
  })

  test('отозванный ключ — forbidden с именем для журнала', () => {
    expect(authenticate(`Bearer ${OLD}`, ring)).toEqual({ ok: false, code: 'forbidden', name: 'todi-old' })
  })

  test('сравнение идёт через crypto.timingSafeEqual и со всеми ключами', () => {
    const spy = spyOn(crypto, 'timingSafeEqual')
    try {
      authenticate(`Bearer ${SECRET}`, ring)
      // Совпал первый ключ, но проверены все три: ранний выход выдал бы
      // по времени ответа, какой по счёту ключ подошёл.
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      spy.mockRestore()
    }
  })

  test('пустое кольцо — всегда unauthorized', () => {
    const empty = loadKeyRing({}).ring
    expect(authenticate(`Bearer ${SECRET}`, empty)).toEqual({ ok: false, code: 'unauthorized' })
  })
})
