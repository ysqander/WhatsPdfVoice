import 'dotenv/config'
import express, { type Request, Response, NextFunction } from 'express'
import { registerRoutes } from './routes'
import { setupVite, serveStatic, log } from './vite'
import { migrateDatabase } from './migrateTables'

const app = express()

// Don't use the JSON middleware for the webhook path to preserve the raw body
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/payment') {
    next()
  } else {
    express.json()(req, res, next)
  }
})

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/payment') {
    next()
  } else {
    express.urlencoded({ extended: false })(req, res, next)
  }
})

app.use((req, res, next) => {
  const start = Date.now()
  const path = req.path
  let capturedJsonResponse: Record<string, any> | undefined = undefined

  const originalResJson = res.json
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson
    return originalResJson.apply(res, [bodyJson, ...args])
  }

  res.on('finish', () => {
    const duration = Date.now() - start
    if (path.startsWith('/api')) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + '…'
      }

      log(logLine)
    }
  })

  next()
})
;(async () => {
  // Run database migrations
  try {
    console.log('Running database migrations...')
    await migrateDatabase()
    console.log('Database migrations completed successfully')
  } catch (error) {
    console.error('Error running database migrations:', error)
  }

  const server = await registerRoutes(app)

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500
    const message = err.message || 'Internal Server Error'

    res.status(status).json({ message })
    throw err
  })

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get('env') === 'development') {
    await setupVite(app, server)
  } else {
    serveStatic(app)
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.

  const isReplit = process.env.REPL_ID !== undefined
  const port = isReplit ? 5000 : 5001
  server.listen(
    {
      port,
      host: '0.0.0.0',
      reusePort: isReplit,
    },
    () => {
      log(`serving on port ${port}`)
    }
  )
})()
