// --- Dependencias ---
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const axios = require('axios');
const { stringify } = require('csv-stringify/sync');
const pLimit = require('p-limit').default;
const path = require('path');

// ltijs usa Provider
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

// ==== Canvas API client + helpers ====
const canvas = axios.create({
  baseURL: `${PLATFORM_URL}/api/v1`,
  headers: { Authorization: `Bearer ${CANVAS_TOKEN || ''}` }
});

// Paginación (sigue los links "next")
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


// Inicializamos Express (tu app web)
const web = express();
web.set('views', path.join(__dirname, 'views'));
web.use(express.urlencoded({ extended: true }));
web.use(express.json());


const isProduction = NODE_ENV === 'production';
// 1. Definimos LTI
const lti = LtiProvider; 

// 2. Configuramos LTI
lti.setup(
  LTI_ENCRYPTION_KEY,
  { url: MONGO_URL },
  { 
    appRoute: '/lti',
    loginRoute: '/login',
    keysetRoute: '/keys',
    devMode: false, // FORZAMOS FALSE PARA QUE USE COOKIES SEGURAS
    cookies: {
      secure: true, // Importante para Render/Canvas
      sameSite: 'None'
    }
  }
);

// 3. Whitelist
lti.whitelist(
  '/', 
  '/canvas-courses', 
  '/course-details',
  '/report',         
  '/report/data',
  '/css',
  '/js'
);

// Muestra el selector de cursos
web.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'selector.html'));
});


web.get('/report', async (req, res) => {
  //const courseId = req.query.course_id;
  const courseId = '128';

  
  try {
    console.time('reporte');
    if (courseId) {
      if (!CANVAS_TOKEN) return res.status(500).send('Falta CANVAS_TOKEN en .env');

      // 1) Alumnos
      console.time('getStudents');
      let students;
      try {
        students = await getStudents(courseId);
      } catch (e) {
        console.error('getStudents ERROR:', e.message);
        return res.status(500).send('Error obteniendo alumnos');
      } finally {
        console.timeEnd('getStudents');
      }

      // 2) Módulos por alumno
      console.time('modsPorAlumno');
      let studentData;
      try {
        const limit = pLimit(8);
        studentData = await Promise.all(
          students.map(s =>
            limit(async () => {
              let mods;
              try {
                mods = await getModulesForStudent(courseId, s.id);
              } catch (e) {
                return [];
              }

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
            })
          )
        );
      } catch (e) {
        return res.status(500).send('Error obteniendo módulos');
      } finally {
        console.timeEnd('modsPorAlumno');
      }

      const flat = studentData.flat();
      const summaryRows = flat.filter(r => r.type === 'summary');
      const detailRows = flat.filter(r => r.type === 'detail');

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
        const key = `${row.student_id}_${row.module_id}`;
        matrix[key] = `${row.module_pct}%`; 
      }

      const studentsList = Array.from(studentsMap.values());
      studentsList.sort((a, b) => (a.sis_user_id || '').localeCompare(b.sis_user_id || '', undefined, { numeric: true }));
      const modulesList = Array.from(modulesMap.values());

      const csvReportData = [];
      for (const s of studentsList) {
        const csvRow = { 'ID IEST': s.sis_user_id, 'Nombre': s.name };
        for (const m of modulesList) {
          csvRow[m.short_name] = matrix[`${s.id}_${m.id}`] || '-';
        }
        csvReportData.push(csvRow);
      }
      
      web.locals[`summ_${courseId}`]   = summaryRows; 
      web.locals[`csv_${courseId}`]    = stringify(csvReportData, { header: true, bom: true });
      web.locals[`detail_${courseId}`] = detailRows;
    }

    console.timeEnd('reporte');
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  } catch (e) {
    res.status(500).send(`Error reporte: ${e.message}`);
  }
});


web.get('/report/data', async (req, res) => {
  const { course_id, kind } = req.query;
  const data = kind === 'csv' ? web.locals[`csv_${course_id}`] : kind === 'detail' ? web.locals[`detail_${course_id}`] : web.locals[`summ_${course_id}`]; 
  if (!data) return res.status(404).send('Sin datos');
  if (kind === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); 
    res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
    return res.send(data);
  }
  res.json(data);
});

web.get('/course-details', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'Falta course_id' });
  try {
    const response = await canvas.get(`/courses/${course_id}`);
    res.json({ id: response.data.id, nombre: response.data.name, codigo: response.data.course_code });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

web.get('/canvas-test', async (req, res) => {
  try {
    const response = await axios.get(`${PLATFORM_URL}/api/v1/courses`, { headers: { Authorization: `Bearer ${CANVAS_TOKEN}` } });
    res.json({ success: true, courses: response.data });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

web.get('/canvas-courses', async (req, res) => {
  try {
    const response = await axios.get(`${PLATFORM_URL}/api/v1/courses`, { headers: { Authorization: `Bearer ${CANVAS_TOKEN}` } });
    const cursos = response.data.map(c => ({ id: c.id, nombre: c.name, codigo: c.course_code }));
    res.json({ success: true, total: cursos.length, cursos });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

web.get('/debug/students', async (req, res) => {
  try {
    const students = await getStudents(req.query.course_id);
    res.json({ total: students.length, students: students.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

web.get('/debug/modules', async (req, res) => {
  try {
    const mods = await getModulesForStudent(req.query.course_id, req.query.student_id);
    res.json({ count: mods.length, sample: mods.slice(0, 1) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

(async () => {
  await lti.deploy({ serverless: true, silent: true });

  // REGISTRO MÚLTIPLE PARA ASEGURAR CONEXIÓN
  const posiblesUrls = [
      PLATFORM_URL, 'https://iest.beta.instructure.com', 'https://iest.beta.instructure.com/',
      'https://canvas.instructure.com', 'https://canvas.instructure.com/',
      'https://canvas.beta.instructure.com', 'https://canvas.beta.instructure.com/'
  ];

  for (const urlVariante of posiblesUrls) {
      if (!urlVariante) continue;
      try {
          await lti.registerPlatform({
              url: urlVariante,
              name: 'Canvas Variant',
              clientId: CLIENT_ID,
              authenticationEndpoint: AUTH_LOGIN_URL,
              accesstokenEndpoint: AUTH_TOKEN_URL,
              authConfig: { method: 'JWK_SET', key: KEYSET_URL }
          });
      } catch (err) {}
  }

  lti.onConnect(async (token, req, res) => {
    const courseId = token?.platformContext?.context?.id;
    if (!courseId) return res.status(400).send('No hay contexto de curso.');
    return res.redirect(`/report?course_id=${courseId}`);
  });

  const host = express();

  // ¡ESTO ES LO QUE ARREGLA EL ERROR MISSING_VALIDATION_COOKIE EN RENDER!
  host.enable('trust proxy'); 
  
  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app);
  host.use('/', web);

  host.listen(PORT, () => console.log(`✅ LTI tool corriendo en ${TOOL_URL}`));

})().catch(err => {
  console.error('❌ Error al iniciar la app:', err);
  process.exit(1);
});