/**
 * Scraper para SICOP - Costa Rica
 * https://www.sicop.go.cr
 *
 * SICOP no tiene API — usa Playwright con sesión real.
 *
 * Flujo descubierto inspeccionando el portal:
 *   1. Formulario en EP_SEJ_COQ600.jsp → Estado=Publicado → "Consultar"
 *   2. Resultados en EP_SEJ_COQ601.jsp → 10 por página → page_no=N
 *   3. Detalle en EP_SEJ_COQ603.jsp?cartelNo=XXXX&cartelSeq=00
 *
 * Estrategia: traer TODOS los concursos publicados (~50-80/semana),
 * filtrar por fecha cierre >= hoy+diasCierreMin, y dejar el scoring al orquestador.
 *
 * ¿Cómo sabe la fecha de hoy?
 *   new Date() siempre devuelve el instante exacto en que corre el script.
 *   La tarea de Windows lo ejecuta a las 8am → hoy ES ese día.
 */

const URL_FORM = 'https://www.sicop.go.cr/moduloOferta/search/EP_SEJ_COQ600.jsp?stateSearch=Y';
const BASE    = 'https://www.sicop.go.cr';
const MAX_PAG = 20; // 200 resultados máximo por ejecución

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseISO(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const c   = new Date(fechaISO); c.setHours(0, 0, 0, 0);
  return Math.round((c - hoy) / 86400000);
}

// ─── Parseo de fila ───────────────────────────────────────────────────────────

/**
 * Parsea una fila <tr> de la tabla de resultados de SICOP.
 *
 * Estructura de celdas:
 *   0 → "{codigoProcedimiento}{NombreInstitucion}"  (concatenado sin separador)
 *   1 → "[TIPO] Descripción del procedimiento Encargado de publicación... : Nombre"
 *   2 → "dd/mm/yyyy hh:mm"  (fecha publicación)
 *   3 → "dd/mm/yyyy hh:mm"  (fecha apertura/cierre)
 *   4 → "Publicado"
 *
 * onclick del enlace → js_cartelSearch('20260500086','00')
 */
function parsearFila(celdas, onclick, portalConfig) {
  if (!celdas || celdas.length < 4) return null;

  // Código de procedimiento: patrón año+tipo+secuencia, ej. "2026LD-000006-0010800001"
  const raw0    = celdas[0] || '';
  const codMatch = raw0.match(/^\d{4}[A-Z]{2,4}-[\d\-]+/);
  const codigo   = codMatch ? codMatch[0] : null;
  const entidad  = codigo ? raw0.slice(codigo.length).trim() : raw0.trim();

  // Descripción: quitar "[TIPO] " al inicio y "Encargado de publicación..." al final
  const raw1    = celdas[1] || '';
  const tipoMatch = raw1.match(/^\[([A-Z]{2,4})\]\s*/);
  const tipo     = tipoMatch ? tipoMatch[1] : null;
  let descripcion = tipoMatch ? raw1.slice(tipoMatch[0].length) : raw1;
  const encargadoIdx = descripcion.indexOf('Encargado de publicación');
  if (encargadoIdx > 0) descripcion = descripcion.slice(0, encargadoIdx).trim();

  const fechaPublicacion = parseISO(celdas[2]);
  const fechaCierre      = parseISO(celdas[3]);

  // URL de búsqueda directa por número de expediente — funciona sin sesión
  // El usuario solo necesita este número para encontrarla en SICOP
  let urlDetalle = `${BASE}/moduloOferta/search/EP_SEJ_COQ600.jsp?stateSearch=Y`;
  if (codigo) {
    // URL que pre-llena el número de procedimiento en el buscador público
    urlDetalle = `${BASE}/moduloOferta/search/EP_SEJ_COQ600.jsp?stateSearch=Y&instCartelNo=${encodeURIComponent(codigo)}`;
  }

  if (!descripcion || descripcion.length < 5) return null;

  return {
    titulo:           descripcion,
    descripcion:      tipo ? `[${tipo}] ${descripcion}` : descripcion,
    entidad:          entidad || 'Desconocida',
    pais:             portalConfig.pais,
    portal:           portalConfig.nombre,
    url:              urlDetalle,
    fecha_publicacion: fechaPublicacion,
    fecha_cierre:     fechaCierre,
    dias_hasta_cierre: diasHastaCierre(fechaCierre),
    monto_estimado:   null,
    moneda:           'CRC',
    numero_expediente: codigo,
    estado:           'Publicado',
    tipo:             tipo,
    _fuente:          'playwright_sicop_cr'
  };
}

// ─── Scraper principal ────────────────────────────────────────────────────────

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const page = await browser.newPage();
  const licitaciones = [];

  try {
    // ── 1. Abrir formulario y buscar Estado=Publicado ──────────────────────
    console.log('  [SICOP CR] Abriendo portal...');
    await page.goto(URL_FORM, { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(1500);

    await page.selectOption('select[name="searchCartelStat"]', { label: 'Publicado' });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click('a[href="javascript:js_search(1)"]')
    ]);
    await page.waitForTimeout(2000);

    // ── 2. Iterar páginas ──────────────────────────────────────────────────
    let pagina = 1;

    while (pagina <= MAX_PAG) {
      // Extraer filas de la página actual
      const filas = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('table tbody tr, table tr'))
          .map(tr => {
            const tds = Array.from(tr.querySelectorAll('td')).map(td =>
              td.textContent?.trim().replace(/\s+/g, ' ') ?? ''
            );
            const enlace = tr.querySelector('a[href*="js_cartelSearch"]');
            const onclick = enlace?.getAttribute('href') ?? null;
            return { celdas: tds, onclick };
          })
          .filter(r => r.celdas.length >= 4);
      });

      console.log(`  [SICOP CR] Página ${pagina}: ${filas.length} filas`);

      for (const fila of filas) {
        const datos = parsearFila(fila.celdas, fila.onclick, portalConfig);
        if (!datos) continue;
        if (datos.dias_hasta_cierre !== null && datos.dias_hasta_cierre < diasCierreMin) continue;
        if (datos.dias_hasta_cierre === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;
        licitaciones.push(datos);
      }

      // ── Buscar link de la siguiente página ─────────────────────────────
      const urlSiguiente = await page.evaluate((pag) => {
        const links = Array.from(document.querySelectorAll('a[href*="page_no"]'));
        const siguiente = links.find(a => a.textContent?.trim() === String(pag + 1));
        return siguiente ? siguiente.getAttribute('href') : null;
      }, pagina);

      if (!urlSiguiente || filas.length === 0) break;

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
        page.goto(`${BASE}${urlSiguiente}`, { waitUntil: 'domcontentloaded' })
      ]);
      await page.waitForTimeout(1500);
      pagina++;
    }

  } catch (err) {
    console.warn(`  [SICOP CR] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  console.log(`  [SICOP CR] Total con cierre ≥${diasCierreMin}d: ${licitaciones.length}`);
  return licitaciones;
}
