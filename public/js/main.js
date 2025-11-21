// public/js/main.js

// --- Variables Globales ---
const params = new URLSearchParams(location.search);
const courseId = params.get('course_id');
const btnCsv = document.getElementById('btnCsv');
const tableWrap = document.getElementById('wrap');
const dashboardWrap = document.getElementById('dashboard-wrap');

// Variables de Gráficas (Conservadas por si las usas luego)
const chartModal = document.getElementById('chartModal');
const modalChartTitle = document.getElementById('modalChartTitle');
const modalChartCanvas = document.getElementById('modalChartCanvas');
const closeButton = document.querySelector('.close-button');

const filtersWrap = document.getElementById('filters-wrap');
const filterName = document.getElementById('filterName');
const filterModule = document.getElementById('filterModule');
// NOTA: Se eliminó filterState de aquí

// Modal de Detalle
const itemDetailModal = document.getElementById('itemDetailModal');
const closeItemDetailModal = document.getElementById('closeItemDetailModal');
const detailCourseName = document.getElementById('detailCourseName');
const detailCourseCode = document.getElementById('detailCourseCode');
const detailStudentName = document.getElementById('detailStudentName');
const itemDetailTableBody = document.getElementById('itemDetailTableBody');

// Estado
let summaryData = null;
let detailData = null;
let currentView = 'summary';
let summaryView = 'avance'; 
let chartInstances = {};
let currentSort = { column: 'sis_user_id', order: 'asc' }; 

// Variable para nombres fijos de módulos
let globalModuleNames = {}; 

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

// Carga datos
async function load(kind) {
    if (kind === 'summary' && summaryData) return summaryData;
    if (kind === 'detail' && detailData) return detailData;
    const res = await fetch(`/report/data?course_id=${courseId}&kind=${kind}`);
    const data = await res.json();
    if (kind === 'summary') summaryData = data;
    if (kind === 'detail') detailData = data;
    return data;
}

// --- Filtros (MODIFICADO: ORDEN REAL Y SIN ESTADO) ---
function populateFilters(data, view) {
    // 1. Lógica para respetar el orden original de los módulos
    const uniqueModules = [];
    const seenModules = new Set();

    data.forEach(item => {
        if (!seenModules.has(item.module_name)) {
            seenModules.add(item.module_name);
            uniqueModules.push(item.module_name);
        }
    });
    
    // Limpiamos y llenamos el select de Módulos
    filterModule.innerHTML = '<option value="all">Todos los módulos</option>';
    uniqueModules.forEach(mod => filterModule.add(new Option(mod, mod)));

    // NOTA: Ya no llenamos filterState porque lo quitaste
}

function applyFilters() {
    const nameFilter = filterName.value.toLowerCase();
    const moduleFilter = filterModule.value;
    // NOTA: Ya no leemos filterState
    
    let filteredData;

    if (currentView === 'summary') {
        if (!summaryData) return;
        filteredData = summaryData.filter(row => {
            const nameMatch = row.student_name.toLowerCase().includes(nameFilter);
            const moduleMatch = moduleFilter === 'all' || row.module_name === moduleFilter;
            // Eliminamos la condición stateMatch
            return nameMatch && moduleMatch;
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

// Render Detalle (Tabla completa)
function renderDetail(rows) {
    const t = ['<table><thead><tr><th>ID IEST</th><th>Alumno</th><th>Módulo</th><th>Item</th><th>Tipo</th><th>Req</th><th>Completado</th></tr></thead><tbody>'];
    for (const r of rows) {
        t.push(`<tr><td>${r.sis_user_id || r.student_id}</td><td>${r.student_name}</td><td>${r.module_name}</td><td>${r.item_title}</td><td>${r.item_type}</td><td>${r.requirement_type || ''}</td><td>${r.completed === true ? '✔️' : (r.completed === false ? '❌' : '')}</td></tr>`);
    }
    t.push('</tbody></table>');
    tableWrap.innerHTML = t.join('');
}

// --- Funciones de Gráficas (Conservadas) ---
function destroyChartInstance(instance) { if (instance) instance.destroy(); }
function createChart(canvasId, config) {
    destroyChartInstance(chartInstances[canvasId]);
    const ctx = document.getElementById(canvasId);
    if (ctx) chartInstances[canvasId] = new Chart(ctx, config);
}
function closeChartModal() {
    if (chartModal) chartModal.style.display = "none";
}

// --- Función Principal de Render (Avance) ---
function renderSumm(rows) {
    const studentsMap = new Map();
    const modulesMap = new Map();
    const matrix = {};

    for (const row of rows) {
        if (!studentsMap.has(row.student_id)) {
            studentsMap.set(row.student_id, { 
                id: row.student_id, 
                name: row.student_name, 
                sis_user_id: row.sis_user_id || row.student_id 
            });
        }
        if (!modulesMap.has(row.module_id)) {
            // Usamos el nombre fijo global
            const fixedName = globalModuleNames[row.module_id] || 'Módulo ?';
            
            modulesMap.set(row.module_id, { 
                id: row.module_id, 
                name: row.module_name, 
                short_name: fixedName 
            });
        }
        const key = `${row.student_id}_${row.module_id}`;
        matrix[key] = { pct: row.module_pct, state: row.module_state || 'N/A' };
    }

    const students = Array.from(studentsMap.values());
    const modules = Array.from(modulesMap.values());

    // Ordenar
    students.sort((a, b) => {
        const valA = a.sis_user_id || '';
        const valB = b.sis_user_id || '';
        return currentSort.order === 'asc' 
            ? valA.localeCompare(valB, undefined, { numeric: true })
            : valB.localeCompare(valA, undefined, { numeric: true });
    });

    // Construir HTML
    const t = [];
    const tableId = 'avanceTable';

    t.push('<div class="table-title-container"><h2>Reporte de avance</h2></div>');
    t.push(`<table class="matrix-table" id="${tableId}">`);
    
    let sortArrow = currentSort.order === 'asc' ? '🔼' : '🔽';
    t.push('<thead><tr>');
    t.push(`<th id="sortByID" class="sortable-header" title="Ordenar por ID">ID IEST ${sortArrow}</th>`);
    t.push('<th>Nombre</th>');

    for (const m of modules) t.push(`<th title="${m.name}">${m.short_name}</th>`); 
    t.push('</tr></thead><tbody>');

    for (const s of students) {
        t.push('<tr>');
        t.push(`<td>${s.sis_user_id}</td><td>${s.name}</td>`);
        for (const m of modules) {
            const cellData = matrix[`${s.id}_${m.id}`];
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

    // Listeners
    const sortableHeader = document.getElementById('sortByID');
    if (sortableHeader) {
        sortableHeader.addEventListener('click', () => {
            currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
            applyFilters();
        });
    }

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
}

// --- Modal de Detalle (SIN CLICKS) ---
async function showItemDetail(studentId, moduleId, studentName, moduleName) {
    if (!detailData) {
        detailData = await load('detail');
    }

    const items = detailData.filter(item => 
        item.student_id == studentId && item.module_id == moduleId
    );

    const requiredItems = items.filter(item => item.requirement_type !== null);
    const vistosItemsList = requiredItems.filter(item => item.completed);
    const pendientesItemsList = requiredItems.filter(item => !item.completed);
    const totalElementos = requiredItems.length;
    const itemsVistos = vistosItemsList.length;
    const itemsPendientes = pendientesItemsList.length;
    const percentage = (totalElementos > 0) ? Math.round((itemsVistos / totalElementos) * 100) : 0;

    detailCourseName.textContent = document.getElementById('courseName').textContent;
    detailCourseCode.textContent = document.getElementById('courseCode').textContent;
    detailStudentName.textContent = studentName;

    itemDetailTableBody.innerHTML = `
        <tr>
            <td>${moduleName}</td>
            <td>${percentage}%</td>
            <td>${itemsVistos}</td>
            <td>${itemsPendientes}</td>
            <td>${totalElementos}</td>
        </tr>
    `;

    document.getElementById('detail-list-container').innerHTML = '';
    itemDetailModal.classList.add('is-visible');
}

// --- Handlers ---
filterName.addEventListener('input', applyFilters);
filterModule.addEventListener('change', applyFilters);
// NOTA: Eliminamos el listener de filterState

btnCsv.onclick = (e) => { e.preventDefault(); window.location.href = `/report/data?course_id=${courseId}&kind=csv`; };

if (closeButton) closeButton.onclick = closeChartModal;
closeItemDetailModal.onclick = () => itemDetailModal.classList.remove('is-visible');
window.addEventListener('click', (event) => {
    if (event.target == chartModal) closeChartModal();
    if (event.target == itemDetailModal) itemDetailModal.classList.remove('is-visible');
});

// --- ARRANQUE ---
(async () => {
    const loader = document.getElementById('loading-overlay');
    if (loader) loader.classList.remove('hidden');

    try {
        // 1. Info Curso
        try {
            const cRes = await fetch(`/course-details?course_id=${courseId}`);
            const c = await cRes.json();
            document.getElementById('courseName').textContent = c.nombre || 'Curso';
            document.getElementById('courseCode').textContent = `Código: ${c.codigo || 'N/A'}`;
        } catch(e) { console.error(e); }

        // 2. Datos Pesados
        const res = await fetch(`/api/process-report?course_id=${courseId}`);
        if (!res.ok) throw new Error('Error cargando datos');
        
        const megaData = await res.json();
        summaryData = megaData.summary;
        detailData = megaData.detail;

        // 3. Generar nombres fijos para módulos
        const uniqueModuleIds = [...new Set(summaryData.map(item => item.module_id))];
        uniqueModuleIds.forEach((id, index) => {
            globalModuleNames[id] = `Módulo ${index}`;
        });

        // 4. Render
        summaryView = 'avance';
        tableWrap.style.display = 'block';
        if (filtersWrap) filtersWrap.style.display = 'flex';
        // Nota: Como borraste el HTML de stateFilterGroup, no hace falta intentar mostrarlo, 
        // pero si lo dejaras en HTML, aquí deberías ocultarlo o borrar esta línea.
        // if (stateFilterGroup) stateFilterGroup.style.display = 'none'; 

        populateFilters(summaryData, 'summary');
        renderSumm(summaryData);

        if (loader) loader.classList.add('hidden');

    } catch (e) {
        console.error(e);
        if (loader) {
            loader.innerHTML = `<h3>Error</h3><p>${e.message}</p>`;
            loader.style.color = 'red';
        }
    }
})();