// ===============================================================
//  server.js - LTI 1.3 Provider para Canvas usando ltijs
// ===============================================================
//  Autor: Rabanito 🥕
//  Propósito:
//   - Manejar el login y launch LTI 1.3 desde Canvas
//   - Servir tu app (reporte de progreso)
//   - Conectarse a la API de Canvas
// ===============================================================

import express from 'express'
import dotenv from 'dotenv'
import axios from 'axios'
import path from 'path'
import { fileURLToPath } from 'url'
import { Provider } from 'ltijs'
import { stringify } from 'csv-stringify/sync'
import pLimit from 'p-limit'

// ------------------ CONFIGURACIÓN ------------------
dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const {
  PORT = 3000,
  PLATFORM_URL,
  AUTH_LOGIN_URL,
  AUTH_TOKEN_URL,
  KEYSET_URL,
  TOOL_URL,
  LTI_ENCRYPTION_KEY,
  CANVAS_TOKEN,
  CLIENT_ID,
  DEPLOYMENT_ID,
  MONGO_URL
} = process.env

// ------------------ CLIENTE CANVAS ------------------
const canvas = axios.create({
  baseURL: `${PLATFORM_URL}/api/v1`,
  headers: { Authorization: `Bearer ${CANVAS_TOKEN || ''}` }
})

async function getAll(url, params = {}) {
  let data = []
  let next = url
  let cfg = { params: { per_page: 100, ...params } }
  while (next) {
    const r = await canvas.get(next, cfg)
    data = data.concat(r.data)
    next = null
    const link = r.headers.link
    if (link) {
      for (const part of link.split(',')) {
        if (part.includes('rel="next"')) {
          next = part.substring(part.indexOf('<') + 1, part.indexOf('>'))
                   .replace(`${PLATFORM_URL}/api/v1`, '')
        }
      }
    }
    cfg = {}
  }
  return data
}

async function getStudents(courseId) {
  const list = await getAll(`/courses/${courseId}/enrollments`, {
    'type[]': 'StudentEnrollment',
    'state[]': 'active'
  })
  return list.map(e => ({
    id: e.user.id,
    name: e.user.name,
    sis_user_id: e.user.sis_id || e.sis_user_id
  }))
}

async function getModulesForStudent(courseId, studentId) {
  return getAll(`/courses/${courseId}/modules`, {
    'include[]': ['items', 'content_details'],
    student_id: studentId
  })
}

// ------------------ EXPRESS ------------------
const web = express()
web.set('views', path.join(__dirname, 'views'))
web.use(express.urlencoded({ extended: true }))
web.use(express.json())

// ------------------ LTI PROVIDER ------------------
const lti = new Provider('LTI-PROGRESS', { url: MONGO_URL }, {
  appRoute: '/lti',
  loginRoute: '/login',
  keysetRoute: '/keys',
  cookies: { secure: true, sameSite: 'None' } // Render usa HTTPS
})

;(async () => {
  console.log('🔧 Iniciando LTI Provider...')

  await lti.setup()

  // --- Registra tu plataforma Canvas ---
  await lti.registerPlatform({
    url: PLATFORM_URL, // https://iest.beta.instructure.com
    name: 'Canvas',
    clientId: CLIENT_ID, // 28419....
    authenticationEndpoint: AUTH_LOGIN_URL, // .../api/lti/authorize_redirect
    accesstokenEndpoint: AUTH_TOKEN_URL, // .../login/oauth2/token
    authConfig: { method: 'JWK_SET', key: KEYSET_URL },
    deploymentId: DEPLOYMENT_ID
  })

  // --- Launch Handler ---
  lti.onConnect((token, req, res) => {
    const courseId = token?.platformContext?.context?.id
    console.log('✅ LTI Launch recibido, contexto:', token?.platformContext)
    if (!courseId) return res.status(400).send('No hay contexto de curso.')
    return res.redirect(`/report?course_id=${courseId}`)
  })

  // --- Middleware debug ISS ---
  const host = express()
  host.use('/login', (req, _res, next) => {
    console.log('🪵 OIDC Login:', req.query)
    next()
  })

  // --- Rutas LTI + web ---
  host.use(express.static(path.join(__dirname, 'public')))
  host.use('/', lti.app)
  host.use('/', web)

  // --- Debug DB LTI ---
  web.get('/debug/lti', async (req, res) => {
    try {
      const db = lti.db
      const platforms = await db.collection('platform').find({}).toArray()
      res.json({
        plataformas_registradas: platforms.map(p => ({
          url: p.platformUrl,
          clientId: p.clientId
        })),
        entorno: {
          PLATFORM_URL,
          CLIENT_ID,
          DEPLOYMENT_ID
        }
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // --- Rutas de tu app ---
  web.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'selector.html')))

  web.get('/report', async (req, res) => {
    const courseId = req.query.course_id
    if (!courseId) return res.status(400).send('Falta course_id')

    try {
      const students = await getStudents(courseId)
      const limit = pLimit(8)
      const results = await Promise.all(students.map(s => limit(async () => {
        const mods = await getModulesForStudent(courseId, s.id)
        return mods.flatMap(m => {
          const items = m.items || []
          const reqItems = items.filter(i => i.completion_requirement)
          const done = reqItems.filter(i => i.completion_requirement.completed).length
          const pct = reqItems.length ? Math.round((100 * done) / reqItems.length) : 0
          return [{
            type: 'summary',
            student_id: s.id, student_name: s.name, module_name: m.name, pct
          }]
        })
      })))

      const flat = results.flat()
      web.locals[`csv_${courseId}`] = stringify(flat, { header: true })
      res.sendFile(path.join(__dirname, 'views', 'index.html'))
    } catch (e) {
      console.error('Error generando reporte:', e.message)
      res.status(500).send('Error generando reporte')
    }
  })

  web.get('/report/data', (req, res) => {
    const { course_id, kind } = req.query
    const data = web.locals[`csv_${course_id}`]
    if (!data) return res.status(404).send('Sin datos')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="reporte.csv"')
    res.send(data)
  })

  // --- Deploy final ---
  await lti.deploy({ serverless: true, silent: true })
  host.listen(PORT, () => console.log(`✅ LTI Tool corriendo en ${TOOL_URL}`))
})().catch(err => {
  console.error('❌ Error al iniciar LTI Tool:', err)
  process.exit(1)
})
