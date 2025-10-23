// --- 💡 NUEVA FUNCIÓN para Imprimir PDF ---
    async function printTableToPdf(tableId, fileName) {
      const tableElement = document.getElementById(tableId);
      if (!tableElement) return console.error(`Tabla ${tableId} no encontrada.`);

      // Seleccionar elementos sticky con más cuidado
      const stickyHeaders = Array.from(tableElement.querySelectorAll('thead th')); 
      const stickyCellsId = Array.from(tableElement.querySelectorAll('tbody td:first-child'));
      const stickyCellsName = Array.from(tableElement.querySelectorAll('tbody td:nth-child(2)'));
      const stickyElements = [...stickyHeaders, ...stickyCellsId, ...stickyCellsName];
      
      const originalStyles = new Map();

      // Quitar sticky y guardar estilos originales
      stickyElements.forEach(el => {
        originalStyles.set(el, { 
            position: el.style.position, 
            backgroundColor: el.style.backgroundColor, 
            color: el.style.color,
            zIndex: el.style.zIndex // Guardar z-index también
        });
        el.style.position = 'static'; // Quitar sticky
        el.style.zIndex = 'auto'; // Resetear z-index
         
         // Restaurar APARIENCIA original que pudo ser sobreescrita por sticky
         if (el.tagName === 'TH') {
             el.style.backgroundColor = '#F58220'; // Naranja
             el.style.color = 'white'; // Blanco
         } else {
             // Para celdas TD, dejamos que el estilo de fila par/impar se encargue
             el.style.backgroundColor = ''; 
             if (el.matches('td:first-child')) {
                el.style.color = '#333'; // Texto oscuro para ID
             }
         }
      });
      
      // Quitar scroll del wrapper
      const wrapper = tableWrap; 
      const originalOverflow = wrapper.style.overflowX;
      wrapper.style.overflowX = 'visible'; 
      
      // Asegurar fondo blanco de la tabla si fue sobreescrito
      const originalTableBg = tableElement.style.backgroundColor;
      tableElement.style.backgroundColor = '#fff'; 

      console.log('Capturando tabla...');
      try {
        const canvas = await html2canvas(tableElement, { 
            scale: 2, 
            useCORS: true, 
            scrollX: 0, 
            scrollY: -window.scrollY,
            backgroundColor: null // Fondo transparente
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
    // --- FIN DE LA FUNCIÓN PDF ---