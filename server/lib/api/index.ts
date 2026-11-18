import fs from 'fs'
import path from 'path'
import type { Router } from 'express'
import { createApiV1Router } from '../../routes/apiV1'
import { countActiveSiteDownloads } from '../downloader'
import { loadApiConfig, type ApiConfig } from './config'
import { JobFiles } from './files'
import { loadKeyRing } from './keys'
import { createPipelineExecutor } from './pipeline'
import { JobQueue } from './queue'
import { JobStore } from './store'

export interface ApiService {
  router: Router
  queue: JobQueue
  config: ApiConfig
  keyNames: string[]
  revokedNames: string[]
  problems: string[]
}

/** API для серверов, собранный из окружения. Пустой API_KEYS — все запросы получают 401. */
export function createApiService(options: { ytDlpVersion: string | null }): ApiService {
  const config = loadApiConfig()
  const { ring, problems } = loadKeyRing()

  fs.mkdirSync(config.dataDir, { recursive: true })
  const store = new JobStore(path.join(config.dataDir, 'jobs.sqlite'))
  const files = new JobFiles(config.dataDir)

  const queue = new JobQueue({
    store,
    files,
    config,
    executor: createPipelineExecutor(files),
    siteActive: countActiveSiteDownloads,
  })

  const router = createApiV1Router({
    store,
    queue,
    files,
    config,
    keyRing: ring,
    ytDlpVersion: options.ytDlpVersion,
    siteActive: countActiveSiteDownloads,
  })

  return {
    router,
    queue,
    config,
    keyNames: ring.active.map((key) => key.name),
    revokedNames: ring.revoked.map((key) => key.name),
    problems,
  }
}
