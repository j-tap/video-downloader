import type { Express } from 'express'
import { downloadHandler } from './download'
import { statusHandler } from './status'
import { fileHandler } from './file'

export function registerRoutes(app: Express) {
  app.post('/download', downloadHandler as any)
  app.get('/status/:id', statusHandler as any)
  app.get('/file/:id', fileHandler as any)
}
