import fs from 'fs'
import path from 'path'

/**
 * Файлы задач API: `<dataDir>/jobs/<id>/` — исходник, готовый `video.mp4`,
 * `thumbnail.jpg`. Один каталог на задачу, поэтому убрать задачу — значит
 * стереть каталог, и после падения посреди работы ничего не теряется по углам.
 */

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const VIDEO_FILE = 'video.mp4'
export const THUMBNAIL_FILE = 'thumbnail.jpg'

export class JobFiles {
  readonly root: string

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'jobs')
    fs.mkdirSync(this.root, { recursive: true })
  }

  dirFor(id: string): string {
    // id приходит из адреса запроса — без проверки `..` увёл бы за пределы тома.
    if (!JOB_ID.test(id)) throw new Error(`bad job id: ${id}`)
    return path.join(this.root, id)
  }

  videoPath(id: string): string {
    return path.join(this.dirFor(id), VIDEO_FILE)
  }

  thumbnailPath(id: string): string {
    return path.join(this.dirFor(id), THUMBNAIL_FILE)
  }

  /** Чистый каталог под новую попытку: остатки прерванной работы не нужны. */
  prepare(id: string): string {
    const dir = this.dirFor(id)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  remove(id: string): void {
    if (!JOB_ID.test(id)) return
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true })
  }

  /** id всех каталогов на томе — для сборщика сирот. */
  listIds(): string[] {
    try {
      return fs.readdirSync(this.root).filter((name) => JOB_ID.test(name))
    } catch {
      return []
    }
  }

  usedBytes(): number {
    return this.listIds().reduce((sum, id) => sum + dirBytes(path.join(this.root, id)), 0)
  }
}

export function dirBytes(dir: string, filter: (name: string) => boolean = () => true): number {
  let total = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }

  for (const name of names) {
    if (!filter(name)) continue
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (stat.isFile()) total += stat.size
    } catch {
      // файл могли стереть между readdir и stat
    }
  }

  return total
}
