// public/js/main.js

// --- Variables Globales ---
const params = new URLSearchParams(location.search);
const courseId = params.get('course_id');
const btnCsv = document.getElementById('btnCsv');
const tableWrap = document.getElementById('wrap');
const filtersWrap = document.getElementById('filters-wrap');
const filterName = document.getElementById('filterName');
const filterModule = document.getElementById('filterModule');
const filterState = document.getElementById('filterState');

// Modales
const itemDetailModal = document.getElementById('itemDetailModal');
const closeItemDetailModal = document.getElementById('closeItemDetailModal');
const detailCourseName = document.getElementById('detailCourseName');
const detailCourseCode = document.getElementById('detailCourseCode');
const detailStudentName = document.getElementById('detailStudentName');
const itemDetailTableBody = document.getElementById('itemDetailTableBody');

// Estado
let summaryData = null;
let detailData = null;
let globalModuleNames = {}; // Mapa para nombres fijos de módulos
let currentSort = { column: 'sis_user_id', order: 'asc' };

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

// --- Filtros ---
function populateFilters(data) {
    const uniqueModules = [...new Set(data.map(item => item.module_name))].sort();
    const uniqueStates = [...new Set(data.map(item => translateState(item.module_state)))].sort();
    
    filterModule.innerHTML = '<option value="all">Todos los módulos</option>';
    filterState.innerHTML = '<option value="all">Todos los estados</option>';
    
    uniqueModules.forEach(mod => filterModule.add(new Option(mod, mod)));
    uniqueStates.forEach(state => filterState.add(new Option(state, state)));
}

function applyFilters() {
    if (!summaryData) return;
    
    const nameFilter = filterName.value.toLowerCase();
    const moduleFilter = filterModule.value;
    const stateFilter = filterState.value;

    const filteredData = summaryData.filter(row => {
        const nameMatch = row.student_name.toLowerCase().includes(nameFilter);
        const moduleMatch = moduleFilter === 'all' || row.module_name === moduleFilter;
        const stateMatch = stateFilter === 'all' || translateState(row.module_state) === stateFilter;
        return nameMatch && moduleMatch && stateMatch;
    });

    renderSumm(filteredData);
}

// --- Render Principal (Tabla Avance) ---
function renderSumm(rows) {
    const studentsMap = new Map();
    const modulesMap = new Map();
    const matrix = {};

    // Procesar datos
    for (const row of rows) {
        if (!studentsMap.has(row.student_id)) {
            studentsMap.set(row.student_id, { 
                id: row.student_id, 
                name: row.student_name, 
                sis_user_id: row.sis_user_id || row.student_id 
            });
        }
        if (!modulesMap.has(row.module_id)) {
            // Usamos el nombre fijo generado al inicio
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
    t.push('<div class="table-title-container"><h2>Reporte de Avance</h2></div>');
    t.push('<table class="matrix-table"><thead><tr>');
    
    const sortArrow = currentSort.order === 'asc' ? '🔼' : '🔽';
    t.push(`<th id="sortByID" class="sortable-header" title="Ordenar">ID IEST ${sortArrow}</th>`);
    t.push('<th>Nombre</th>');
    
    for (const m of modules) {
        t.push(`<th title="${m.name}">${m.short_name}</th>`);
    }
    t.push('</tr></thead><tbody>');

    for (const s of students) {
        t.push('<tr>');
        t.push(`<td>${s.sis_user_id}</td><td>${s.name}</td>`);
        for (const m of modules) {
            const cellData = matrix[`${s.id}_${m.id}`];
            if (cellData) {
                t.push(`<td title="${translateState(cellData.state)}" 
                          class="clickable-cell" 
                          data-sid="${s.id}" data-mid="${m.id}" 
                          data-sname="${s.name}" data-mname="${m.name}">
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
    document.getElementById('sortByID')?.addEventListener('click', () => {
        currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
        applyFilters();
    });

    tableWrap.querySelectorAll('.clickable-cell').forEach(cell => {
        cell.addEventListener('click', () => {
            showItemDetail(cell.dataset.sid, cell.dataset.mid, cell.dataset.sname, cell.dataset.mname);
        });
    });
}

// --- Modal Detalle (Solo visualización, sin clicks) ---
function showItemDetail(studentId, moduleId, studentName, moduleName) {
    const items = detailData.filter(item => item.student_id == studentId && item.module_id == moduleId);
    
    const requiredItems = items.filter(item => item.requirement_type !== null);
    const vistos = requiredItems.filter(item => item.completed).length;
    const pendientes = requiredItems.filter(item => !item.completed).length;
    const total = requiredItems.length;
    const pct = total > 0 ? Math.round((vistos / total) * 100) : 0;

    detailCourseName.textContent = document.getElementById('courseName').textContent;
    detailCourseCode.textContent = document.getElementById('courseCode').textContent;
    detailStudentName.textContent = studentName;

    // Tabla simple sin clases clickeables
    itemDetailTableBody.innerHTML = `
        <tr>
            <td>${moduleName}</td>
            <td>${pct}%</td>
            <td>${vistos}</td>
            <td>${pendientes}</td>
            <td>${total}</td>
        </tr>
    `;

    document.getElementById('detail-list-container').innerHTML = ''; // Limpiar lista
    itemDetailModal.classList.add('is-visible');
}

// --- Eventos Generales ---
filterName.addEventListener('input', applyFilters);
filterModule.addEventListener('change', applyFilters);
filterState.addEventListener('change', applyFilters);

btnCsv.onclick = (e) => { 
    e.preventDefault(); 
    window.location.href = `/report/data?course_id=${courseId}&kind=csv`; 
};

closeItemDetailModal.onclick = () => itemDetailModal.classList.remove('is-visible');
window.addEventListener('click', (e) => {
    if (e.target == itemDetailModal) itemDetailModal.classList.remove('is-visible');
});

// --- Arranque (Loading + Fetch) ---
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

        // 3. Generar nombres fijos para módulos (Corrección Módulo 0)
        const uniqueModuleIds = [...new Set(summaryData.map(item => item.module_id))];
        uniqueModuleIds.forEach((id, index) => {
            globalModuleNames[id] = `Módulo ${index}`;
        });

        // 4. Render
        tableWrap.style.display = 'block';
        filtersWrap.style.display = 'flex';
        populateFilters(summaryData);
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