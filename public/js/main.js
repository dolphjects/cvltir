
    // --- Tus variables y funciones existentes ---
    const params = new URLSearchParams(location.search);
    const courseId = params.get('course_id');
    const btnToggle = document.getElementById('btnToggle'), btnCsv = document.getElementById('btnCsv'), btnDashboard = document.getElementById('btnDashboard');
    const btnToggleSummary = document.getElementById('btnToggleSummary');
    const tableWrap = document.getElementById('wrap'), dashboardWrap = document.getElementById('dashboard-wrap');
    const chartModal = document.getElementById('chartModal'), modalChartTitle = document.getElementById('modalChartTitle'), modalChartCanvas = document.getElementById('modalChartCanvas'), closeButton = document.querySelector('.close-button');
    const filtersWrap = document.getElementById('filters-wrap'), filterName = document.getElementById('filterName'), filterModule = document.getElementById('filterModule'), filterState = document.getElementById('filterState'), stateFilterGroup = document.getElementById('stateFilterGroup');

    let summaryData = null, detailData = null;
    let currentView = 'summary';
    let summaryView = 'avance'; 
    let chartInstances = {};

    // --- Tus funciones auxiliares (copiadas de tu código) ---
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
        const nameFilter = filterName.value.toLowerCase(), moduleFilter = filterModule.value, stateFilter = filterState.value;
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
    // --- Fin de tus funciones auxiliares ---


    // --- 💡 renderSumm MODIFICADO CON BOTÓN PDF ---
    function renderSumm(rows) {
      // 1. Procesar datos (igual que tu versión)
      const studentsMap = new Map();
      const modulesMap = new Map();
      const matrix = {};
      let moduleCounter = 1;
      for (const row of rows) {
        if (!studentsMap.has(row.student_id)) studentsMap.set(row.student_id, { id: row.student_id, name: row.student_name, sis_user_id: row.sis_user_id || row.student_id });
        if (!modulesMap.has(row.module_id)) modulesMap.set(row.module_id, { id: row.module_id, name: row.module_name, short_name: `Módulo ${moduleCounter++}` });
        const key = `${row.student_id}_${row.module_id}`;
        matrix[key] = { pct: row.module_pct, state: row.module_state || 'N/A' };
      }
      const students = Array.from(studentsMap.values());
      const modules = Array.from(modulesMap.values());
      const t = [];
      
      let tableId = '';
      let pdfFileName = '';

      if (summaryView === 'avance') {
        tableId = 'avanceTable';
        pdfFileName = `Reporte_Avance_${courseId}.pdf`;
        // --- Título y Botón PDF ---
        t.push('<div class="table-title-container">');
        t.push('<h2>Reporte de Avance</h2>');
        t.push(`<button class="pill print-button" id="printAvanceBtn">📄 Imprimir PDF</button>`);
        t.push('</div>');
        // --- Tabla Avance ---
        t.push(`<table class="matrix-table" id="${tableId}">`); // ID añadido
        t.push('<thead><tr><th>ID IEST</th><th>Nombre</th>');
        for (const m of modules) t.push(`<th title="${m.name}">${m.short_name}</th>`); 
        t.push('</tr></thead><tbody>');
        for (const s of students) {
          t.push('<tr>');
          t.push(`<td>${s.sis_user_id}</td><td>${s.name}</td>`);
          for (const m of modules) {
            const key = `${s.id}_${m.id}`;
            const cellData = matrix[key];
            t.push(cellData ? `<td title="${translateState(cellData.state)}">${cellData.pct}%</td>` : '<td>-</td>');
          }
          t.push('</tr>');
        }
        t.push('</tbody></table>');

      } else { // Si summaryView es 'estados'
        tableId = 'estadosTable';
        pdfFileName = `Reporte_Estados_${courseId}.pdf`;
        // --- Título y Botón PDF ---
        t.push('<div class="table-title-container">');
        t.push('<h2>Reporte de Estados</h2>'); // Título correcto
        t.push(`<button class="pill print-button" id="printEstadosBtn">📄 Imprimir PDF</button>`);
        t.push('</div>');
        // --- Tabla Estados ---
        t.push(`<table class="matrix-table" id="${tableId}">`); // ID añadido
        t.push('<thead><tr><th>ID IEST</th><th>Nombre</th>');
        for (const m of modules) t.push(`<th title="${m.name}">${m.short_name}</th>`);
        t.push('</tr></thead><tbody>');
        for (const s of students) {
          t.push('<tr>');
          t.push(`<td>${s.sis_user_id}</td><td>${s.name}</td>`);
          for (const m of modules) {
            const key = `${s.id}_${m.id}`;
            const cellData = matrix[key];
            t.push(cellData ? `<td>${translateState(cellData.state)}</td>` : '<td>-</td>');
          }
          t.push('</tr>');
        }
        t.push('</tbody></table>');
      }

      tableWrap.innerHTML = t.join('');

      // --- Attach Event Listener para el botón PDF ---
      const printButtonId = (summaryView === 'avance') ? 'printAvanceBtn' : 'printEstadosBtn';
      const printButton = document.getElementById(printButtonId);
      if (printButton) {
        printButton.addEventListener('click', () => printTableToPdf(tableId, pdfFileName));
      }
    }
    // --- FIN DE renderSumm MODIFICADO ---
    // --- Tus Handlers de Botones y Arranque (SIN CAMBIOS) ---
    function switchView(view) {
      currentView = view;
      tableWrap.style.display = 'none';
      dashboardWrap.style.display = 'none';
      filtersWrap.style.display = 'none';
      btnToggle.style.display = 'none';
      btnToggleSummary.style.display = 'none';

      if (view === 'summary') {
          tableWrap.style.display = 'block';
          filtersWrap.style.display = 'flex';
          btnToggle.style.display = 'inline-flex';
          btnToggle.textContent = '📂 Ver detalles';
          btnToggleSummary.style.display = 'inline-flex';
          btnToggleSummary.textContent = (summaryView === 'avance') ? '🚦 Ver Estados' : '📝 Ver Avance'; 
          stateFilterGroup.style.display = 'flex';
      } else if (view === 'detail') {
          tableWrap.style.display = 'block';
          filtersWrap.style.display = 'flex';
          btnToggle.style.display = 'inline-flex';
          btnToggle.textContent = '📋 Ver Avance'; // Tu cambio
          stateFilterGroup.style.display = 'none';
      } else if (view === 'dashboard') {
          dashboardWrap.style.display = 'grid';
          btnToggleSummary.style.display = 'inline-flex';
          btnToggleSummary.textContent = '📝 Ver Avance'; 
      }
    }
    btnToggle.onclick = async () => {
      if (currentView === 'detail') {
        summaryView = 'avance';
        switchView('summary');
        populateFilters(summaryData, 'summary');
        applyFilters(); 
      } else { 
        switchView('detail');
        const d = detailData || await load('detail');
        populateFilters(d, 'detail');
        applyFilters(); 
      }
    };
    btnToggleSummary.onclick = () => {
      if (currentView === 'dashboard') {
        summaryView = 'avance'; 
        switchView('summary');
        applyFilters();
      } else { 
        summaryView = (summaryView === 'avance') ? 'estados' : 'avance';
        btnToggleSummary.textContent = (summaryView === 'avance') ? '🚦 Ver Estados' : '📝 Ver Avance';
        applyFilters(); 
      }
    };
    btnDashboard.onclick = async () => {
        if (currentView !== 'dashboard') {
            switchView('dashboard');
            const s = summaryData || await load('summary');
            renderDashboard(s);
        } else { 
            summaryView = 'avance'; 
            switchView('summary');
            applyFilters();
        }
    };
    filterName.addEventListener('input', applyFilters);
    filterModule.addEventListener('change', applyFilters);
    filterState.addEventListener('change', applyFilters);
    btnCsv.onclick = (e) => { e.preventDefault(); window.location.href = `/report?course_id=${courseId}&kind=csv`; };
    closeButton.onclick = closeChartModal;
    window.onclick = (event) => { if (event.target == chartModal) closeChartModal(); };
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
      switchView('summary');
      populateFilters(s, 'summary');
      renderSumm(s); // Render inicial
    })();
    // --- Fin de tus Handlers y Arranque ---