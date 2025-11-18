// --- Variables Globales ---
const params = new URLSearchParams(location.search);
const courseId = params.get('course_id');
const btnCsv = document.getElementById('btnCsv');
const tableWrap = document.getElementById('wrap'), dashboardWrap = document.getElementById('dashboard-wrap');
const chartModal = document.getElementById('chartModal'), modalChartTitle = document.getElementById('modalChartTitle'), modalChartCanvas = document.getElementById('modalChartCanvas'), closeButton = document.querySelector('.close-button');
const filtersWrap = document.getElementById('filters-wrap'), filterName = document.getElementById('filterName'), filterModule = document.getElementById('filterModule'), filterState = document.getElementById('filterState'), stateFilterGroup = document.getElementById('stateFilterGroup');

// Modal de Detalle
const itemDetailModal = document.getElementById('itemDetailModal');
const closeItemDetailModal = document.getElementById('closeItemDetailModal');
const detailCourseName = document.getElementById('detailCourseName');
const detailCourseCode = document.getElementById('detailCourseCode');
const detailStudentName = document.getElementById('detailStudentName');
const itemDetailTableBody = document.getElementById('itemDetailTableBody');

// Estado
let summaryData = null, detailData = null;
let currentView = 'summary';
let summaryView = 'avance'; 
let chartInstances = {};
let currentSort = { column: 'sis_user_id', order: 'asc' }; // Para ordenar

// --- Funciones Auxiliares ---
const translateState = (state) => {
  switch(state) {
    case 'completed': return 'Completado';
    case 'started': return 'Iniciado';
    case 'locked': return 'Bloqueado';
    case 'unlocked': return 'Desbloqueado';
    case 'N/A': return 'N/A';
    default: return state || 'N/A';
  }
};

// Carga datos (summary o detail) desde el servidor
async function load(kind) {
  if (kind === 'summary' && summaryData) return summaryData;
  if (kind === 'detail' && detailData) return detailData;
  const res = await fetch(`/report/data?course_id=${courseId}&kind=${kind}`);
  const data = await res.json();
  if (kind === 'summary') summaryData = data;
  if (kind === 'detail') detailData = data;
  return data;
}

// Llena los selectores de filtro
function populateFilters(data, view) {
    const uniqueModules = [...new Set(data.map(item => item.module_name))].sort();
    const uniqueStates = view === 'summary' ? [...new Set(data.map(item => translateState(item.module_state)))].sort() : [];
    filterModule.innerHTML = '<option value="all">Todos los módulos</option>';
    filterState.innerHTML = '<option value="all">Todos los estados</option>';
    uniqueModules.forEach(mod => filterModule.add(new Option(mod, mod)));
    if (view === 'summary') {
        uniqueStates.forEach(state => {
            const option = new Option(state, state);
            filterState.add(option);
        });
    }
}

// Aplica los filtros seleccionados
function applyFilters() {
    const nameFilter = filterName.value.toLowerCase();
    const moduleFilter = filterModule.value;
    const stateFilter = filterState.value;
    let filteredData;

    if (currentView === 'summary') {
        if (!summaryData) return;
        filteredData = summaryData.filter(row => {
            const nameMatch = row.student_name.toLowerCase().includes(nameFilter);
            const moduleMatch = moduleFilter === 'all' || row.module_name === moduleFilter;
            const stateMatch = stateFilter === 'all' || translateState(row.module_state) === stateFilter;
            return nameMatch && moduleMatch && stateMatch;
        });
        renderSumm(filteredData);
    } else if (currentView === 'detail') {
        // (Lógica de filtro para la vista de detalle si se usara)
        if (!detailData) return;
        filteredData = detailData.filter(row => {
            const nameMatch = row.student_name.toLowerCase().includes(nameFilter);
            const moduleMatch = moduleFilter === 'all' || row.module_name === moduleFilter;
            return nameMatch && moduleMatch;
        });
        renderDetail(filteredData);
    }
}

// Pinta la tabla de 'detalle' (la que no estamos usando mucho)
function renderDetail(rows) {
  const t = ['<table><thead><tr><th>ID IEST</th><th>Alumno</th><th>Módulo</th><th>Item</th><th>Tipo</th><th>Req</th><th>Completado</th></tr></thead><tbody>'];
  for (const r of rows) {
    t.push(`<tr><td>${r.sis_user_id || r.student_id}</td><td>${r.student_name}</td><td>${r.module_name}</td><td>${r.item_title}</td><td>${r.item_type}</td><td>${r.requirement_type || ''}</td><td>${r.completed === true ? '✔️' : (r.completed === false ? '❌' : '')}</td></tr>`);
  }
  t.push('</tbody></table>');
  tableWrap.innerHTML = t.join('');
}

// --- Funciones de Gráficas (Dashboard) ---
function destroyChartInstance(instance) { if (instance) instance.destroy(); }
function createChart(canvasId, config) {
    destroyChartInstance(chartInstances[canvasId]);
    const ctx = document.getElementById(canvasId);
    if (ctx) chartInstances[canvasId] = new Chart(ctx, config);
}
function renderDashboard(data) {
    // ... (Código de gráficas, no se usa por ahora pero está)
}
function getModuleChartConfig(data) {
    // ... (Código de gráficas)
}
function getStudentChartConfig(data) {
    // ... (Código de gráficas)
}
function getStatusChartConfig(data) {
    // ... (Código de gráficas)
}
function openChartModal(chartInfo, allData) {
    // ... (Código de gráficas)
}
function closeChartModal() {
    // ... (Código de gráficas)
}

// --- Función Principal de Render (Avance) ---
function renderSumm(rows) {
  // 1. Procesar datos
  const studentsMap = new Map();
  const modulesMap = new Map();
  const matrix = {};
  let moduleCounter = 0; // Iniciar en Módulo 0
  for (const row of rows) {
    if (!studentsMap.has(row.student_id)) studentsMap.set(row.student_id, { id: row.student_id, name: row.student_name, sis_user_id: row.sis_user_id || row.student_id });
    if (!modulesMap.has(row.module_id)) modulesMap.set(row.module_id, { id: row.module_id, name: row.module_name, short_name: `Módulo ${moduleCounter++}` });
    const key = `${row.student_id}_${row.module_id}`;
    matrix[key] = { pct: row.module_pct, state: row.module_state || 'N/A' };
  }
  const students = Array.from(studentsMap.values());
  const modules = Array.from(modulesMap.values());

  // 2. Ordenar datos por ID
  students.sort((a, b) => {
      const valA = a.sis_user_id || '';
      const valB = b.sis_user_id || '';
      if (currentSort.order === 'asc') {
          return valA.localeCompare(valB, undefined, { numeric: true });
      } else {
          return valB.localeCompare(valA, undefined, { numeric: true });
      }
  });

  // 3. Construir HTML
  const t = [];
  const tableId = 'avanceTable';

  t.push('<div class="table-title-container">');
  t.push('<h2>Reporte de Avance</h2>');
  // (Línea del botón PDF eliminada)
  t.push('</div>');
  
  t.push(`<table class="matrix-table" id="${tableId}">`);
  
  // Header con flecha de ordenamiento
  let sortArrow = currentSort.order === 'asc' ? '🔼' : '🔽';
  t.push('<thead><tr>');
  t.push(`<th id="sortByID" class="sortable-header" title="Ordenar por ID">ID IEST ${sortArrow}</th>`);
  t.push('<th>Nombre</th>');

  for (const m of modules) t.push(`<th title="${m.name}">${m.short_name}</th>`); 
  t.push('</tr></thead><tbody>');

  // Filas de datos
  for (const s of students) {
    t.push('<tr>');
    t.push(`<td>${s.sis_user_id}</td><td>${s.name}</td>`);
    for (const m of modules) {
      const key = `${s.id}_${m.id}`;
      const cellData = matrix[key];
      // Celda clickeable con data-attributes
      if (cellData) {
          t.push(`<td title="${translateState(cellData.state)}" 
                      class="clickable-cell" 
                      data-student-id="${s.id}" 
                      data-module-id="${m.id}"
                      data-student-name="${s.name}"
                      data-module-name="${m.name}">
                      ${cellData.pct}%
                  </td>`);
      } else {
          t.push('<td>-</td>');
      }
    }
    t.push('</tr>');
  }
  t.push('</tbody></table>');

  tableWrap.innerHTML = t.join('');

  // 4. Añadir Listeners
  // Listener para ordenar
  const sortableHeader = document.getElementById('sortByID');
  if (sortableHeader) {
      sortableHeader.addEventListener('click', () => {
          currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
          applyFilters(); // Re-renderizar
      });
  }

  // Listener para celdas de detalle
  const cells = tableWrap.querySelectorAll('.clickable-cell');
  cells.forEach(cell => {
      cell.addEventListener('click', () => {
          showItemDetail(
              cell.dataset.studentId,
              cell.dataset.moduleId,
              cell.dataset.studentName,
              cell.dataset.moduleName
          );
      });
  });

  // (Listener para botón PDF eliminado)
}

// --- Funciones para Modal de Detalle ---

// Muestra el modal flotante
async function showItemDetail(studentId, moduleId, studentName, moduleName) {
  // 1. Cargar datos si no existen
  if (!detailData) {
      console.log('Cargando datos de detalle...');
      detailData = await load('detail');
  }

  // 2. Filtrar items
  const items = detailData.filter(item => 
      item.student_id == studentId && item.module_id == moduleId
  );

  // 3. Calcular totales Y SEPARAR LISTAS
  const requiredItems = items.filter(item => item.requirement_type !== null);
  const vistosItemsList = requiredItems.filter(item => item.completed);
  const pendientesItemsList = requiredItems.filter(item => !item.completed);

  const totalElementos = requiredItems.length;
  const itemsVistos = vistosItemsList.length;
  const itemsPendientes = pendientesItemsList.length;
  const percentage = (totalElementos > 0) ? Math.round((itemsVistos / totalElementos) * 100) : 0;

  // 4. Llenar info del modal
  detailCourseName.textContent = document.getElementById('courseName').textContent;
  detailCourseCode.textContent = document.getElementById('courseCode').textContent;
  detailStudentName.textContent = studentName;

  // 5. Llenar la tabla (CON IDs y Clases nuevas)
  itemDetailTableBody.innerHTML = `
      <tr>
          <td>${moduleName}</td>
          <td>${percentage}%</td>
          <td id="show-vistos" class="clickable-detail-count" title="Clic para ver lista">
              ${itemsVistos}
          </td>
          <td id="show-pendientes" class="clickable-detail-count" title="Clic para ver lista">
              ${itemsPendientes}
          </td>
          <td>${totalElementos}</td>
      </tr>
  `;

  // 6. AÑADIR LISTENERS a los números
  document.getElementById('show-vistos').addEventListener('click', () => {
      renderDetailList(vistosItemsList, 'Items Vistos');
  });
  document.getElementById('show-pendientes').addEventListener('click', () => {
      renderDetailList(pendientesItemsList, 'Items Pendientes');
  });

  // 7. Limpiar la lista anterior
  document.getElementById('detail-list-container').innerHTML = '';

  // 8. Mostrar el modal
  itemDetailModal.classList.add('is-visible');
}

// Pinta la lista de items (vistos o pendientes) en el modal
function renderDetailList(items, title) {
    const container = document.getElementById('detail-list-container');
    const html = [];

    // Título (ej: "Items Pendientes (18)")
    html.push(`<h3>${title} (${items.length})</h3>`);

    if (items.length === 0) {
        html.push('<p>No hay items que mostrar en esta sección.</p>');
    } else {
        html.push('<ul class="detail-item-list">');
        
        // Mapea los tipos de Canvas a algo más legible
        const itemTypes = {
            'Assignment': 'Tarea',
            'Discussion': 'Foro',
            'Page': 'Página',
            'Quiz': 'Examen',
            'File': 'Archivo',
            'ExternalUrl': 'Enlace'
        };

        for (const item of items) {
            const itemType = itemTypes[item.item_type] || item.item_type || 'Item'; // Traduce el tipo
            html.push(`
                <li>
                    ${item.item_title}
                    <span class="item-type">${itemType}</span>
                </li>
            `);
        }
        html.push('</ul>');
    }

    // Inyecta el HTML en el contenedor
    container.innerHTML = html.join('');
}


// (Función printTableToPdf eliminada)


// --- Handlers de Eventos ---
filterName.addEventListener('input', applyFilters);
filterModule.addEventListener('change', applyFilters);
filterState.addEventListener('change', applyFilters);
btnCsv.onclick = (e) => { e.preventDefault(); window.location.href = `/report/data?course_id=${courseId}&kind=csv`; };

// Handlers de Modales
closeButton.onclick = closeChartModal;
closeItemDetailModal.onclick = () => itemDetailModal.classList.remove('is-visible');

window.addEventListener('click', (event) => {
    if (event.target == chartModal) closeChartModal();
    if (event.target == itemDetailModal) itemDetailModal.classList.remove('is-visible');
});


// --- Función de Arranque ---
(async () => {
  const s = await load('summary'); // Carga datos iniciales
  try {
    // Pide info del curso
    const courseRes = await fetch(`/course-details?course_id=${courseId}`);
    const course = await courseRes.json();
    document.getElementById('courseName').textContent = course.nombre;
    document.getElementById('courseCode').textContent = `Código: ${course.codigo || 'N/A'}`;
  } catch (e) {
    console.error('No se pudieron cargar los detalles del curso', e);
    document.getElementById('courseName').textContent = 'Curso no encontrado';
  }
  summaryView = 'avance';
  
  // Mostrar tabla y filtros
  tableWrap.style.display = 'block';
  filtersWrap.style.display = 'flex';
  stateFilterGroup.style.display = 'flex';

  populateFilters(s, 'summary');
  renderSumm(s); // Render inicial
})();