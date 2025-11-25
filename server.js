const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const axios = require('axios');
const { stringify } = require('csv-stringify/sync');
const pLimit = require('p-limit').default;
const path = require('path');
const LtiProvider = require('ltijs').Provider;

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
  MONGO_URL,
  NODE_ENV 
} = process.env;

// --- Helpers Canvas ---
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
  return list.map(e => ({ id: e.user.id, name: e.user.name, sis_user_id: e.user.sis_id || e.sis_user_id }));
}

async function getModulesForStudent(courseId, studentId) {
  return getAll(`/courses/${courseId}/modules`, {
    'include[]': ['items', 'content_details'],
    student_id: studentId
  });
}

// --- Lógica Central del Reporte (Reutilizable) ---
async function generateReportData(courseId) {
  if (!CANVAS_TOKEN) throw new Error('Falta CANVAS_TOKEN');
  
  const students = await getStudents(courseId);
  const limit = pLimit(8);
  
  const studentData = await Promise.all(
    students.map(s =>
      limit(async () => {
        try {
          const mods = await getModulesForStudent(courseId, s.id);
          const rows = [];
          for (const m of mods) {
            if (m.name === 'Programa del Curso') continue; 
            const items = m.items || [];
            const reqItems = items.filter(i => !!i.completion_requirement);
            const done = reqItems.filter(i => i.completion_requirement.completed).length;
            const pct = reqItems.length ? Math.round((100 * done) / reqItems.length) : 0;

            rows.push({
              type: 'summary',
              student_id: s.id,
              student_name: s.name,
              sis_user_id: s.sis_user_id,
              module_id: m.id,
              module_name: m.name,
              module_state: m.state,
              module_pct: pct
            });

            for (const it of items) {
              rows.push({
                type: 'detail',
                student_id: s.id,
                student_name: s.name,
                sis_user_id: s.sis_user_id,
                module_id: m.id,
                module_name: m.name,
                item_id: it.id,
                item_title: it.title,
                item_type: it.type,
                requirement_type: it.completion_requirement?.type || null,
                completed: it.completion_requirement?.completed ?? null,
                due_at: it.content_details?.due_at || null,
                html_url: it.html_url || null
              });
            }
          }
          return rows;
        } catch (e) { return []; }
      })
    )
  );

  const flat = studentData.flat();
  const summaryRows = flat.filter(r => r.type === 'summary');
  const detailRows = flat.filter(r => r.type === 'detail');

  // Generar CSV String
  const studentsMap = new Map();
  const modulesMap = new Map();
  const matrix = {};
  let moduleCounter = 0;

  for (const row of summaryRows) {
    if (!studentsMap.has(row.student_id)) {
      studentsMap.set(row.student_id, {
        id: row.student_id,
        name: row.student_name,
        sis_user_id: row.sis_user_id || row.student_id
      });
    }
    if (!modulesMap.has(row.module_id)) {
      modulesMap.set(row.module_id, {
        id: row.module_id,
        name: row.module_name,
        short_name: `Módulo ${moduleCounter++}`
      });
    }
    matrix[`${row.student_id}_${row.module_id}`] = `${row.module_pct}%`; 
  }

  const studentsList = Array.from(studentsMap.values()).sort((a, b) => 
    (a.sis_user_id || '').localeCompare(b.sis_user_id || '', undefined, { numeric: true })
  );
  const modulesList = Array.from(modulesMap.values());
  const csvReportData = [];

  for (const s of studentsList) {
    const csvRow = { 'ID IEST': s.sis_user_id, 'Nombre': s.name };
    for (const m of modulesList) {
      csvRow[m.short_name] = matrix[`${s.id}_${m.id}`] || '-';
    }
    csvReportData.push(csvRow);
  }

  return {
    summary: summaryRows,
    detail: detailRows,
    csv: stringify(csvReportData, { header: true, bom: true })
  };
}

// --- Configuración Servidor ---
const web = express();
web.set('views', path.join(__dirname, 'views'));
web.use(express.urlencoded({ extended: true }));
web.use(express.json());

const isProduction = NODE_ENV === 'production';
const lti = LtiProvider; 

lti.setup(
  LTI_ENCRYPTION_KEY,
  { url: MONGO_URL },
  { 
    appRoute: '/lti',
    loginRoute: '/login',
    keysetRoute: '/keys',
    devMode: false, 
    cookies: { secure: true, sameSite: 'None' }
  }
);

lti.whitelist('/', '/canvas-courses', '/course-details', '/report', '/report/data', '/api/process-report', '/css', '/js', '/img');

// --- Rutas ---

web.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'selector.html'));
});

// 1. Ruta Rápida (Solo HTML + Pantalla Carga)
web.get('/report', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// 2. Ruta API (Lógica Pesada para Main.js)
web.get('/api/process-report', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'Falta course_id' });
  
  try {
    console.time(`API_${course_id}`);
    const data = await generateReportData(course_id);
    console.timeEnd(`API_${course_id}`);
    res.json({ summary: data.summary, detail: data.detail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Ruta CSV (Descarga directa)
web.get('/report/data', async (req, res) => {
  const { kind, course_id } = req.query;
  if (!course_id) return res.status(400).send('Falta course_id');
  
  // Cache simple en memoria (opcional, para el CSV)
  const cacheKey = `csv_${course_id}`;
  if (kind === 'csv' && web.locals[cacheKey]) {
     res.setHeader('Content-Type', 'text/csv; charset=utf-8'); 
     res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
     return res.send(web.locals[cacheKey]);
  }

  try {
    const data = await generateReportData(course_id);
    if (kind === 'csv') {
      web.locals[cacheKey] = data.csv; // Guardamos en cache simple
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); 
      res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
      return res.send(data.csv);
    }
    res.status(400).send('Solo CSV soportado en esta ruta por ahora');
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// --- Rutas Auxiliares ---
web.get('/course-details', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'Falta course_id' });
  try {
    const response = await canvas.get(`/courses/${course_id}`);
    res.json({ id: response.data.id, nombre: response.data.name, codigo: response.data.course_code });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/*
web.get('/canvas-test', async (req, res) => {
  try {
    const response = await axios.get(`${PLATFORM_URL}/api/v1/courses`, { headers: { Authorization: `Bearer ${CANVAS_TOKEN}` } });
    res.json({ success: true, courses: response.data });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
*/

web.get('/canvas-courses', async (req, res) => {
  try {
    if (!CANVAS_TOKEN) throw new Error('Falta CANVAS_TOKEN en .env');

    // 1. Limpieza inteligente de URL (Quita la barra final si existe)
    // Esto evita el error de "doble slash" que rompe la API
    const baseUrl = PLATFORM_URL.endsWith('/') ? PLATFORM_URL.slice(0, -1) : PLATFORM_URL;
    
    console.log(`🔍 Selector pidiendo cursos a: ${baseUrl}/api/v1/courses`);

    // 2. Petición a Canvas
    const response = await axios.get(`${baseUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
      params: {
        per_page: 100,              // Traer hasta 100 cursos
        enrollment_state: 'active', // Solo cursos activos
        include: ['term']           // Opcional: traer periodo escolar
      }
    });

    // 3. Mapeo de datos (Limpieza para tu HTML)
    const cursos = response.data.map(curso => ({
      id: curso.id,
      nombre: curso.name,
      codigo: curso.course_code
    }));

    console.log(`✅ Cursos encontrados: ${cursos.length}`);
    res.json({ success: true, total: cursos.length, cursos });

  } catch (error) {
    console.error("❌ Error en /canvas-courses:", error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.response?.data 
    });
  }
});

// --- Deploy ---
(async () => {
  await lti.deploy({ serverless: true, silent: true });

  const posiblesUrls = [
      PLATFORM_URL, 'https://iest.beta.instructure.com', 'https://iest.beta.instructure.com/',
      'https://canvas.instructure.com', 'https://canvas.instructure.com/',
      'https://canvas.beta.instructure.com', 'https://canvas.beta.instructure.com/',
      'https://iest.instructure.com','https://iest.instructure.com/'
  ];

  for (const url of posiblesUrls) {
      if (!url) continue;
      try {
          await lti.registerPlatform({
              url: url,
              name: 'Canvas Variant',
              clientId: CLIENT_ID,
              authenticationEndpoint: AUTH_LOGIN_URL,
              accesstokenEndpoint: AUTH_TOKEN_URL,
              authConfig: { method: 'JWK_SET', key: KEYSET_URL }
          });
      } catch (err) {}
  }

  lti.onConnect(async (token, req, res) => {
    const customId = token.platformContext.custom && token.platformContext.custom.canvas_course_id;
    const courseId = customId || token.platformContext.context.id;
    
    if (!courseId) return res.status(400).send('No hay contexto de curso.');
    return res.redirect(`/report?course_id=${courseId}`);
  });

  const host = express();
  host.enable('trust proxy'); 
  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app);
  host.use('/', web);

  host.listen(PORT, () => console.log(`✅ LTI tool corriendo en ${TOOL_URL}`));

})().catch(err => {
  console.error('❌ Error al iniciar la app:', err);
  process.exit(1);
});