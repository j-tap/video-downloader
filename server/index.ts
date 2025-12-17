import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'
import { registerRoutes } from './routes'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const port = process.env.PORT || 3000
const app = express()

app.use(cors())
app.use(express.json())

// Статические файлы из папки client (должно быть первым)
const clientPath = path.join(__dirname, '../client')
app.use(express.static(clientPath, {
  maxAge: 0, // Отключаем кеш в development
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    // Отключаем кеш для статических файлов в development
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    }
  }
}))

// Регистрируем API маршруты
registerRoutes(app)

// Отдаем index.html для корневого маршрута (в самом конце)
app.get('/', (req, res) => {
  // Отключаем кеш для HTML
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.sendFile(path.join(clientPath, 'index.html'))
})

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`)
  console.log(`Client path: ${clientPath}`)
})
