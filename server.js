// ===============================================================
//  server.js - LTI 1.3 Provider para Canvas usando ltijs (CommonJS)
// ===============================================================

const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const axios = require('axios');
const { stringify } = require('csv-stringify/sync');
const pLimit = require('p-limit'); // CommonJS
const path = require('path');
const LTIProvider = require('ltijs').Provider;

// ------------------ ENV ------------------
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
} = process.env;

// ------------------ CLIENTE CANVAS ------------------
const canvas = axios.create({
  baseURL: `${PLATFORM_URL}/api/v1`,
  headers: { Authorization: `Bearer ${CANVAS_TOKEN || ''}` }
});

async function getAll(url, params = {}) {
  let out = [];
  let next = url;
  let cfg = { params: { per_page: 100, ...params } };
  while (next) {
    const r = await canvas.get(next, cfg);
    out = out.concat(r.data);
    next = null;
    const link = r.headers.link;
    if (link) {
      for (const part of link.split(',')) {
        if (part.includes('rel="next"')) {
          next = part.substring(part.indexOf('<') + 1, part.indexOf('>'))
                     .replace(`${PLATFORM_URL}/api/v1`, '');
        }
      }
    }
    cfg = {};
  }
  return out;
}

async function getStudents(courseId) {
  const list = await getAll(`/courses/${courseId}/enrollments`, {
    'type[]': 'StudentEnrollment',
    'state[]': 'active'
  });
  return list.map(e => ({
    id: e.user.id,
    name: e.user.name,
    sis_user_id: e.user.sis_id || e.sis_user_id
  }));
}

async function getModulesForStudent(courseId, studentId) {
  return getAll(`/courses/${courseId}/modules`, {
    'include[]': ['items', 'content_details'],
    student_id: studentId
  });
}

// ------------------ TU APP WEB ------------------
const web = express();
web.set('views', path.join(__dirname, 'views'));
web.use(express.urlencoded({ extended: true }));
web.use(express.json());

// Páginas principales
web.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'selector.html'));
});

web.get('/report', async (req, res) => {
  const courseId = req.query.course_id;
  try {
    if (!courseId) return res.status(400).send('Falta course_id');
    if (!CANVAS_TOKEN) return res.status(500).send('Falta CANVAS_TOKEN');

    const students = await getStudents(courseId);

    const limit = pLimit(8);
    const rowsNested = await Promise.all(
      students.map(s => limit(async () => {
        const mods = await getModulesForStudent(courseId, s.id);
        const rows = [];
        for (const m of mods) {
          const items = m.items || [];
          const reqItems = items.filter(i => !!i.completion_requirement);
          const done = reqItems.filter(i => i.completion_requirement.completed).length;
          const pct = reqItems.length ? Math.round((100 * done) / reqItems.length) : 0;
          rows.push({
            type: 'summary',
            student_id: s.id, student_name: s.name,
            sis_user_id: s.sis_user_id,
            module_id: m.id, module_name: m.name,
            module_state: m.state, module_pct: pct
          });
          for (const it of items) {
            rows.push({
              type: 'detail',
              student_id: s.id, student_name: s.name,
              sis_user_id: s.sis_user_id,
              module_id: m.id, module_name: m.name,
              item_id: it.id, item_title: it.title, item_type: it.type,
              requirement_type: it.completion_requirement?.type || null,
              completed: it.completion_requirement?.completed ?? null,
              due_at: it.content_details?.due_at || null,
              html_url: it.html_url || null
            });
          }
        }
        return rows;
      }))
    );

    const flat = rowsNested.flat();
    const summaryRows = flat.filter(r => r.type === 'summary');
    const detailRows  = flat.filter(r => r.type === 'detail');

    web.locals[`summ_${courseId}`]   = summaryRows;
    web.locals[`detail_${courseId}`] = detailRows;
    web.locals[`csv_${courseId}`]    = stringify(flat, { header: true });

    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  } catch (e) {
    const msg = e?.response?.data || e?.message || String(e);
    const code = e?.response?.status || 500;
    console.error('Reporte ERROR:', code, msg);
    res.status(500).send(`Error construyendo reporte (${code}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
});

web.get('/report/data', (req, res) => {
  const { course_id, kind } = req.query;
  const data =
    kind === 'csv' ? web.locals[`csv_${course_id}`] :
    kind === 'detail' ? web.locals[`detail_${course_id}`] :
    web.locals[`summ_${course_id}`];

  if (!data) return res.status(404).send('Sin datos');

  if (kind === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
    return res.send(data);
  }
  res.json(data);
});

// Debug de la DB de ltijs
web.get('/debug/lti', async (req, res) => {
  try {
    const db = lti.db;
    const platforms = await db.collection('platform').find({}).toArray();
    res.json({
      plataformas_registradas: platforms.map(p => ({
        url: p.platformUrl,
        clientId: p.clientId,
        authEndpoint: p.authEndpoint,
        accesstokenEndpoint: p.accesstokenEndpoint
      })),
      entorno: { PLATFORM_URL, CLIENT_ID, DEPLOYMENT_ID }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------ LTI PROVIDER ------------------
// Nota: En CommonJS, ¡sí existe el constructor!
const lti = new LTIProvider(
  LTI_ENCRYPTION_KEY,
  { url: MONGO_URL },
  {
    appRoute: '/lti',
    loginRoute: '/login',
    keysetRoute: '/keys',
    cookies: { secure: true, sameSite: 'None' } // Render usa HTTPS
  }
);

(async () => {
  // 1) Desplegar ltijs (conecta DB, rutas, etc.)
  await lti.deploy({ serverless: true, silent: true });

  // 2) Registrar la plataforma (issuer)
  await lti.registerPlatform({
    url: PLATFORM_URL, // p.ej. https://iest.beta.instructure.com
    name: 'Canvas',
    clientId: CLIENT_ID, // numérico
    authenticationEndpoint: AUTH_LOGIN_URL, // .../api/lti/authorize_redirect
    accesstokenEndpoint: AUTH_TOKEN_URL,    // .../login/oauth2/token
    authConfig: { method: 'JWK_SET', key: KEYSET_URL },
    deploymentId: DEPLOYMENT_ID
  });

  // 3) Handler de launch
  lti.onConnect((token, req, res) => {
    const courseId = token?.platformContext?.context?.id;
    if (!courseId) return res.status(400).send('No hay contexto de curso.');
    return res.redirect(`/report?course_id=${courseId}`);
  });

  // 4) Servidor host
  const host = express();

  // — Logger para ver el iss del OIDC login —
  host.use('/login', (req, _res, next) => {
    console.log('OIDC /login query:', req.query); // mira aquí el `iss`
    next();
  });

  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app); // rutas LTI
  host.use('/', web);     // tu app

  host.listen(PORT, () => {
    console.log(`✅ LTI Tool corriendo en ${TOOL_URL}`);
  });
})().catch(err => {
  console.error('❌ Error al iniciar la app:', err);
  process.exit(1);
});
