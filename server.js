// Servidor principal de la aplicación de reportes LTI.
// Responsabilidades:
// 1. Autenticación LTI 1.3 contra Canvas (usando ltijs y MongoDB).
// 2. Consumo de la API de Canvas para obtener datos (alumnos, módulos).
// 3. Servir la aplicación web (HTML/CSS/JS) y una API de datos interna.

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
  NODE_ENV // <-- CORRECCIÓN: Necesitamos esta variable
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

// --- CORRECCIÓN 1: Detectar producción para las cookies ---
const isProduction = NODE_ENV === 'production';
// --- FIN CORRECCIÓN 1 ---

// Inicializamos LTI Provider
const lti = LtiProvider; 
lti.setup(
  'LTI-PROGRESS',
  { url: MONGO_URL },
  {
    appRoute: '/lti',     
    loginRoute: '/login', 
    keysetRoute: '/keys',
    cookieSecure: isProduction, // <-- CORRECCIÓN 1 (Debe ser true en HTTPS)
    ltiKey: LTI_ENCRYPTION_KEY
  }
);

// Whitelist
lti.whitelist(
  '/', 
  '/canvas-courses', 
  '/course-details',
  '/report',       
  '/report/data',
  '/css',
  '/js',
  '/debug/lti'
);

//debug jlmh
web.get('/debug/lti', async (req, res) => {
  try {
    const db = lti.db;
    if (!db) {
      return res.status(500).json({ error: 'La base de datos de LTI no está inicializada.' });
    }
    
    // Busca la colección 'platform'
    const platforms = await db.collection('platform').find({}).toArray();
    
    // Muestra lo que encontró, Y TAMBIÉN lo que hay en las variables de entorno
    res.json({
      message: `Esto es lo que LTIJS tiene en su base de datos AHORA MISMO:`,
      variables_de_entorno_actuales: {
        CLIENT_ID_EN_RENDER: process.env.CLIENT_ID || 'NO DEFINIDO',
        DEPLOYMENT_ID_EN_RENDER: process.env.DEPLOYMENT_ID || 'NO DEFINIDO',
        PLATFORM_URL_EN_RENDER: process.env.PLATFORM_URL || 'NO DEFINIDO'
      },
      plataformas_registradas_en_mongo: platforms
    });

  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});
//debug jlmh end

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
        studentData = await Promise.all(students.map(s => limit(async () => {
          let mods;
          try {
            mods = await getModulesForStudent(courseId, s.id);
          } catch (e) {
            console.error(`getModulesForStudent ERROR (student ${s.id}):`,
              e.response?.status, e.response?.data || e.message);
            return [];
          }

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
        })));
      } catch (e) {
        console.error('modsPorAlumno ERROR:', e.response?.status, e.response?.data || e.message);
        return res.status(500).send('Error obteniendo módulos');
      } finally {
        console.timeEnd('modsPorAlumno');
      }

      // 3) guarda y flat los datos obtenidos 
      const flat = studentData.flat();
      console.log(`Filas totales: ${flat.length}`);
      
      const summaryRows = flat.filter(r => r.type === 'summary');
      const detailRows = flat.filter(r => r.type === 'detail');
      
      web.locals[`summ_${courseId}`]   = summaryRows; 
      web.locals[`csv_${courseId}`]    = stringify(flat, { header: true });
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
    res.setHeader('Content-Type', 'text/csv');
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
  // 1. Despliega LTIJS (esto INICIA la conexión a la BD)
  await lti.deploy({ serverless: true, silent: true });

  // --- CORRECCIÓN 3: ESPERAR A QUE LA BD ESTÉ LISTA ---
  try {
    // Esperamos activamente a que lti.db esté disponible
    while (!lti.db) {
      console.log('Esperando conexión con la base de datos...');
      await new Promise(resolve => setTimeout(resolve, 100)); // Espera 100ms
    }
    console.log('Base de datos conectada, procediendo con la limpieza.');

    // Ahora lti.db SÍ existe, podemos borrar con seguridad
    console.log(`Buscando y eliminando plataforma antigua para: ${PLATFORM_URL}`);
    await lti.db.collection('platform').deleteOne({ platformUrl: PLATFORM_URL });
    console.log('Plataforma antigua eliminada. Se registrará con los nuevos .env.');

  } catch (err) {
    console.error('Error limpiando plataforma antigua:', err);
  }
  // --- FIN CORRECCIÓN 3 ---

  // 2. REGISTRA LA PLATAFORMA (Ahora creará un documento fresco)
  console.log(`Registrando plataforma con CLIENT_ID: ${CLIENT_ID} y DEPLOYMENT_ID: ${DEPLOYMENT_ID}`);
  await lti.registerPlatform({
    url: PLATFORM_URL,
    name: 'Canvas',
    clientId: CLIENT_ID || 'TO_FILL',
    authenticationEndpoint: AUTH_LOGIN_URL,
    accesstokenEndpoint: AUTH_TOKEN_URL,
    authConfig: { method: 'JWK_SET', key: KEYSET_URL },
    deploymentId: DEPLOYMENT_ID || 'TO_FILL' 
  });
  console.log('Plataforma registrada/actualizada exitosamente.');

  // 3. Define qué hacer en una conexión exitosa
  lti.onConnect(async (token, req, res) => {
    const courseId = token?.platformContext?.context?.id;
    if (!courseId) return res.status(400).send('No hay contexto de curso.');
    // Redirige al reporte específico del curso
    return res.redirect(`/report?course_id=${courseId}`);
  });

  // 4. Crea el servidor
  const host = express();

  // 5. Configuracion del orden de las rutas
  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app); 
  host.use('/', web);

  // 6. Enciende el servidor
  host.listen(PORT, () => console.log(`✅ LTI tool corriendo en ${TOOL_URL}`));

})().catch(err => {
  console.error('❌ Error al iniciar la app:', err);
  process.exit(1);
});