import express from 'express'
import cors from 'cors'
import path from 'path'
import 'dotenv/config'
import { registerRoutes } from './routes'

const port = process.env.PORT || 3000
const app = express()

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '../client')))

registerRoutes(app)

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`)
})
