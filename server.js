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
  DEPLOYMENT_ID,
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
// 1. Definimos LTI (Como lo tenías)
const lti = LtiProvider; 

// 2. Configuramos LTI
lti.setup(
  LTI_ENCRYPTION_KEY,   // <-- CORRECCIÓN: La clave de encriptación real
  { url: MONGO_URL },    // La base de datos
  { // Opciones
    appRoute: '/lti',
    loginRoute: '/login',
    keysetRoute: '/keys',
    devMode: !isProduction // <-- La forma moderna de 'cookieSecure'
  }
);

// 3. ¡LA WHITELIST VA AFUERA, COMO LA TENÍAS ANTES!
// Esto le dice a LTI que NO proteja estas rutas.
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
  const courseId = req.query.course_id;

  try {
    console.time('reporte');
    if (courseId) {
      if (!CANVAS_TOKEN) return res.status(500).send('Falta CANVAS_TOKEN en .env');

      // 1) Alumnos
      console.time('getStudents');
      let students;
      try {
        students = await getStudents(courseId);
        console.log(`getStudents OK: ${students.length} alumnos`);
      } catch (e) {
        console.error('getStudents ERROR:', e.response?.status, e.response?.data || e.message);
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
                console.error(
                  `getModulesForStudent ERROR (student ${s.id}):`,
                  e.response?.status,
                  e.response?.data || e.message
                );
                return [];
              }

              const rows = [];
              for (const m of mods) {
                
                // --- 💡 MODIFICACIÓN 1: SALTAR MÓDULO ---
                // Si el nombre del módulo es "Programa del curso", sáltalo y no lo proceses.
                if (m.name === 'Programa del Curso') {
                    continue; // Pasa al siguiente módulo
                }
                // --- 💡 FIN DE LA MODIFICACIÓN 1 ---

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
        console.error('modsPorAlumno ERROR:', e.response?.status, e.response?.data || e.message);
        return res.status(500).send('Error obteniendo módulos');
      } finally {
        console.timeEnd('modsPorAlumno');
      }

      // 3) Procesa los datos y ¡CREA EL CSV PIVOTADO!
      const flat = studentData.flat();
      console.log(`Filas totales: ${flat.length}`);

      const summaryRows = flat.filter(r => r.type === 'summary');
      const detailRows = flat.filter(r => r.type === 'detail');

      // --- INICIO: Lógica para generar CSV pivotado (Reporte de Avance) ---
      const studentsMap = new Map();
      const modulesMap = new Map();
      const matrix = {};
      
      // --- 💡 MODIFICACIÓN 2: CONTADOR DESDE 0 ---
      let moduleCounter = 0; // Cambiado de 1 a 0
      // --- 💡 FIN DE LA MODIFICACIÓN 2 ---

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
            short_name: `Módulo ${moduleCounter++}` // Esto ahora generará Módulo 0, Módulo 1, etc.
          });
        }
        const key = `${row.student_id}_${row.module_id}`;
        matrix[key] = `${row.module_pct}%`; // Guardamos el texto del porcentaje
      }

      const studentsList = Array.from(studentsMap.values());
      studentsList.sort((a, b) => {
    // Usamos localeCompare con numeric: true para ordenar "1000" vs "200" correctamente
    return (a.sis_user_id || '').localeCompare(b.sis_user_id || '', undefined, { numeric: true });
});
      const modulesList = Array.from(modulesMap.values());

      // Este array se convertirá en tu CSV idéntico al reporte web
      const csvReportData = [];

      for (const s of studentsList) {
        // Empezamos cada fila con los datos del estudiante
        const csvRow = {
          'ID IEST': s.sis_user_id,
          'Nombre': s.name
        };

        // Añadimos dinámicamente las columnas de módulos
        for (const m of modulesList) {
          const key = `${s.id}_${m.id}`;
          const cellData = matrix[key];
          // Usamos el nombre corto (ej: "Módulo 1") como cabecera
          csvRow[m.short_name] = cellData || '-';
        }
        csvReportData.push(csvRow);
      }
      
      // === ¡AQUÍ ESTÁ LA CORRECCIÓN! ===
      // Guardamos los datos que SÍ quieres (csvReportData) en la variable
      // que tu ruta /report/data va a leer.
      web.locals[`summ_${courseId}`]   = summaryRows; 
      web.locals[`csv_${courseId}`]    = stringify(csvReportData, { header: true, bom: true }); // <--- CAMBIO HECHO AQUÍ
      web.locals[`detail_${courseId}`] = detailRows;
    }

    console.timeEnd('reporte');
    // Envía la página del reporte
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  } catch (e) {
    const msg = e?.response?.data || e?.message || String(e);
    const code = e?.response?.status || 500;
    console.error('Reporte ERROR:', code, msg);
    
    console.timeEnd('modsPorAlumno');
    console.timeEnd('reporte');

    res.status(500).send(`Error construyendo reporte (${code}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
});


web.get('/report/data', async (req, res) => {
  const { course_id, kind } = req.query;
  const data =
    kind === 'csv' ? web.locals[`csv_${course_id}`] :
    kind === 'detail' ? web.locals[`detail_${course_id}`] :
    web.locals[`summ_${course_id}`]; 

  if (!data) return res.status(404).send('Sin datos');

  if (kind === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); // Añadido charset por si acaso
    res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
    return res.send(data);
  }

  res.json(data);
});

// Nueva ruta para obtener detalles de un solo curso por ID
web.get('/course-details', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'Falta course_id' });

  try {
    const response = await canvas.get(`/courses/${course_id}`);
    const curso = response.data;
    res.json({
      id: curso.id,
      nombre: curso.name,
      codigo: curso.course_code
    });
  } catch (error) {
    console.error('Error fetching course details:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// Prueba conexión a Canvas con el token
web.get('/canvas-test', async (req, res) => {
  try {
    const response = await axios.get(`${PLATFORM_URL}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` }
    });
    res.json({ success: true, courses: response.data });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// Cursos resumidos: solo ID y nombre
web.get('/canvas-courses', async (req, res) => {
  try {
    const response = await axios.get(`${PLATFORM_URL}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` }
    });
    const cursos = response.data.map(curso => ({
      id: curso.id,
      nombre: curso.name,
     codigo: curso.course_code
    }));
    res.json({ success: true, total: cursos.length, cursos });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

web.get('/debug/students', async (req, res) => {
  try {
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ error: 'Falta course_id' });
    const students = await getStudents(course_id);
    res.json({ total: students.length, students: students.slice(0, 10) });
  } catch (e) {
    console.error('DEBUG students:', e.response?.status, e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

web.get('/debug/modules', async (req, res) => {
  try {
    const { course_id, student_id } = req.query;
    if (!course_id || !student_id) return res.status(400).json({ error: 'Falta course_id o student_id' });
    const mods = await getModulesForStudent(course_id, student_id);
    res.json({ count: mods.length, sample: mods.slice(0, 1) });
  } catch (e) {
    console.error('DEBUG modules:', e.response?.status, e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

(async () => {
  await lti.deploy({ serverless: true, silent: true });

  try {
    console.log(`Intentando eliminar plataforma antigua para: ${PLATFORM_URL} con ClientID: ${CLIENT_ID}`);
    await lti.deletePlatform(PLATFORM_URL, CLIENT_ID); 
    console.log('Plataforma antigua eliminada exitosamente (si existía).');
  } catch (err) {
    console.log('No se pudo eliminar plataforma (probablemente no existía):', err.message);
  }
  console.log(`Registrando plataforma con CLIENT_ID: ${CLIENT_ID}`); // Ya no logueamos el DEPLOYMENT_ID
  await lti.registerPlatform({
    url: PLATFORM_URL, // https://iest.beta.instructure.com
    name: 'Canvas',
    clientId: CLIENT_ID,
    authenticationEndpoint: AUTH_LOGIN_URL,
    accesstokenEndpoint: AUTH_TOKEN_URL,
    authConfig: { method: 'JWK_SET', key: KEYSET_URL }
  });
  
  const urlConBarra = 'https://iest.beta.instructure.com/'; 
  
  try {
    console.log('Registrando plataforma secundaria (con slash)...');
    await lti.registerPlatform({
      url: urlConBarra,
      name: 'Canvas Slash',
      clientId: CLIENT_ID, // El mismo Client ID
      authenticationEndpoint: AUTH_LOGIN_URL,
      accesstokenEndpoint: AUTH_TOKEN_URL,
      authConfig: { method: 'JWK_SET', key: KEYSET_URL }
    });
  } catch (err) {
    console.log('La plataforma con slash ya estaba registrada.');
  }

  lti.onConnect(async (token, req, res) => {
    const courseId = token?.platformContext?.context?.id;
    if (!courseId) return res.status(400).send('No hay contexto de curso.');
    // Redirige al reporte específico del curso
    return res.redirect(`/report?course_id=${courseId}`);
  });

  const host = express();

  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app); // Ahora lti.app SÍ conoce la plataforma registrada
  host.use('/', web);

  host.listen(PORT, () => console.log(`✅ LTI tool corriendo en ${TOOL_URL}`));

})().catch(err => {
  console.error('❌ Error al iniciar la app:', err);
  process.exit(1);
});