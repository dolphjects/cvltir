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

async function load(kind) {
  if (kind === 'summary' && summaryData) return summaryData;
  if (kind === 'detail' && detailData) return detailData;
  const res = await fetch(`/report/data?course_id=${courseId}&kind=${kind}`);
  const data = await res.json();
  if (kind === 'summary') summaryData = data;
  if (kind === 'detail') detailData = data;
  return data;
}

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

function applyFilters() {
    const nameFilter = filterName.value.toLowerCase(); // Filtro simple
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
        if (!detailData) return;
        filteredData = detailData.filter(row => {
            const nameMatch = row.student_name.toLowerCase().includes(nameFilter);
            const moduleMatch = moduleFilter === 'all' || row.module_name === moduleFilter;
            return nameMatch && moduleMatch;
        });
        renderDetail(filteredData);
    }
}

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
    dashboardWrap.innerHTML = '';
    const chartsToCreate = [
        { id: 'moduleProgressChart', title: 'Progreso Promedio por Módulo', creator: getModuleChartConfig },
        { id: 'studentProgressChart', title: 'Progreso General por Alumno', creator: getStudentChartConfig },
        { id: 'statusDistributionChart', title: 'Distribución de Estados de Módulos', creator: getStatusChartConfig }
    ];
    chartsToCreate.forEach(chartInfo => {
        const container = document.createElement('div');
        container.className = 'chart-container';
        container.innerHTML = `<h2>${chartInfo.title}</h2><div class="chart-wrapper"><canvas id="${chartInfo.id}"></canvas></div>`;
        dashboardWrap.appendChild(container);
        container.addEventListener('click', () => openChartModal(chartInfo, data));
        createChart(chartInfo.id, chartInfo.creator(data));
    });
}
function getModuleChartConfig(data) {
    const moduleData = data.reduce((acc, row) => { if (!acc[row.module_name]) acc[row.module_name] = { sum: 0, count: 0 }; acc[row.module_name].sum += row.module_pct; acc[row.module_name].count++; return acc; }, {});
    const labels = Object.keys(moduleData), averages = labels.map(label => moduleData[label].sum / moduleData[label].count);
    return { type: 'bar', data: { labels, datasets: [{ label: '% de Avance Promedio', data: averages, backgroundColor: 'rgba(245, 130, 32, 0.7)' }] }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100 }, x: { title: { display: true, text: 'Módulos' } } }, plugins: { legend: { display: false } } } };
}
function getStudentChartConfig(data) {
    const studentData = data.reduce((acc, row) => { if (!acc[row.student_name]) acc[row.student_name] = { sum: 0, count: 0 }; acc[row.student_name].sum += row.module_pct; acc[row.student_name].count++; return acc; }, {});
    const sortedStudents = Object.entries(studentData).sort(([, a], [, b]) => (b.sum / b.count) - (a.sum / a.count));
    const labels = sortedStudents.map(([name]) => name), averages = sortedStudents.map(([, { sum, count }]) => sum / count);
    return { type: 'bar', data: { labels, datasets: [{ label: '% de Avance Promedio', data: averages, backgroundColor: 'rgba(245, 130, 32, 0.7)' }] }, options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { beginAtZero: true, max: 100 } }, plugins: { legend: { display: false } } } };
}
function getStatusChartConfig(data) {
    const statusCounts = data.reduce((acc, row) => { const state = row.module_state || 'N/A'; acc[state] = (acc[state] || 0) + 1; return acc; }, {});
    const labels = Object.keys(statusCounts), counts = Object.values(statusCounts);
    const colors = ['#F58220', '#FFB81C', '#808080', '#D9531E', '#EEEEEE'];
    return { type: 'pie', data: { labels, datasets: [{ label: 'Número de Módulos', data: counts, backgroundColor: colors }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } } };
}
function openChartModal(chartInfo, allData) {
    modalChartTitle.textContent = chartInfo.title;
    chartModal.classList.add('is-visible');
    createChart('modalChartCanvas', chartInfo.creator(allData));
}
function closeChartModal() {
    chartModal.classList.remove('is-visible');
    destroyChartInstance(chartInstances['modalChartCanvas']);
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

  // 2. Ordenar datos
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
  const pdfFileName = `Reporte_Avance_${courseId}.pdf`;

  t.push('<div class="table-title-container">');
  t.push('<h2>Reporte de Avance</h2>');
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

  // Listener para botón PDF
  const printButton = document.getElementById('printAvanceBtn');
  if (printButton) {
    printButton.addEventListener('click', () => printTableToPdf(tableId, pdfFileName));
  }
}

// --- Función para Modal de Detalle ---
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

  // 3. Calcular totales
  const requiredItems = items.filter(item => item.requirement_type !== null);
  const totalElementos = requiredItems.length;
  const itemsVistos = requiredItems.filter(item => item.completed).length;
  const itemsPendientes = totalElementos - itemsVistos;
  const percentage = (totalElementos > 0) ? Math.round((itemsVistos / totalElementos) * 100) : 0;

  // 4. Llenar info del modal
  detailCourseName.textContent = document.getElementById('courseName').textContent;
  detailCourseCode.textContent = document.getElementById('courseCode').textContent;
  detailStudentName.textContent = studentName;

  // 5. Llenar la tabla
  itemDetailTableBody.innerHTML = `
      <tr>
          <td>${moduleName}</td>
          <td>${percentage}%</td>
          <td>${itemsVistos}</td>
          <td>${itemsPendientes}</td>
          <td>${totalElementos}</td>
      </tr>
  `;

  // 6. Mostrar el modal
  itemDetailModal.classList.add('is-visible');
}


// --- Función para Imprimir PDF ---
async function printTableToPdf(tableId, fileName) {
  const tableElement = document.getElementById(tableId);
  if (!tableElement) return console.error(`Tabla ${tableId} no encontrada.`);

  const stickyHeaders = Array.from(tableElement.querySelectorAll('thead th')); 
  const stickyCellsId = Array.from(tableElement.querySelectorAll('tbody td:first-child'));
  const stickyCellsName = Array.from(tableElement.querySelectorAll('tbody td:nth-child(2)'));
  const stickyElements = [...stickyHeaders, ...stickyCellsId, ...stickyCellsName];
  
  const originalStyles = new Map();

  // Quitar sticky y guardar estilos
  stickyElements.forEach(el => {
    originalStyles.set(el, { 
        position: el.style.position, 
        backgroundColor: el.style.backgroundColor, 
        color: el.style.color,
        zIndex: el.style.zIndex
    });
    el.style.position = 'static';
    el.style.zIndex = 'auto';
     
    if (el.tagName === 'TH') {
        el.style.backgroundColor = '#F58220';
        el.style.color = 'white';
    } else {
        el.style.backgroundColor = ''; 
        if (el.matches('td:first-child')) {
          el.style.color = '#333';
        }
    }
  });
  
  const wrapper = tableWrap; 
  const originalOverflow = wrapper.style.overflowX;
  wrapper.style.overflowX = 'visible'; 
  
  const originalTableBg = tableElement.style.backgroundColor;
  tableElement.style.backgroundColor = '#fff'; 

  console.log('Capturando tabla...');
  try {
    const canvas = await html2canvas(tableElement, { 
        scale: 2, 
        useCORS: true, 
        scrollX: 0, 
        scrollY: -window.scrollY,
        backgroundColor: null
    });
    console.log('Captura completa, generando PDF...');
    const imgData = canvas.toDataURL('image/png');
    const { jsPDF } = window.jspdf;
    const pdfWidth = canvas.width;
    const pdfHeight = canvas.height;
    const orientation = pdfWidth > pdfHeight ? 'l' : 'p';
    const pdf = new jsPDF({ orientation: orientation, unit: 'px', format: [pdfWidth, pdfHeight] });
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
    pdf.save(fileName);
    console.log('PDF guardado.');
  } catch(err) {
      console.error("Error generando PDF:", err);
  } finally {
      // Restaurar estilos
      originalStyles.forEach((styles, el) => {
          el.style.position = styles.position;
          el.style.backgroundColor = styles.backgroundColor;
          el.style.color = styles.color;
          el.style.zIndex = styles.zIndex;
      });
      wrapper.style.overflowX = originalOverflow;
      tableElement.style.backgroundColor = originalTableBg;
      console.log('Estilos restaurados.');
  }
}

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
  const s = await load('summary');
  try {
    const courseRes = await fetch(`/course-details?course_id=${courseId}`);
    const course = await courseRes.json();
    document.getElementById('courseName').textContent = course.nombre;
    document.getElementById('courseCode').textContent = `Código: ${course.codigo || 'N/A'}`;
  } catch (e) {
    console.error('No se pudieron cargar los detalles del curso', e);
    document.getElementById('courseName').textContent = 'Curso no encontrado';
  }
  summaryView = 'avance';
  
  // Mostrar tabla y filtros (ya no hay switchView)
  tableWrap.style.display = 'block';
  filtersWrap.style.display = 'flex';
  stateFilterGroup.style.display = 'flex';

  populateFilters(s, 'summary');
  renderSumm(s); // Render inicial
})();