/**
 * Scraper para SEACE - Perú
 * https://prod2.seace.gob.pe/seacebus-uifc/buscadorPublico/buscadorPublico.xhtml
 *
 * Portal JSF (JavaServer Faces) — sin API pública.
 * Playwright navega el formulario y extrae la tabla de resultados.
 *
 * ADVERTENCIA: El servidor SEACE tiene períodos de mantenimiento frecuentes.
 * Si retorna 0 licitaciones, puede ser que el portal esté caído — revisar manualmente.
 */

const PORTAL_URL = 'https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml';
const BASE       = 'https://prod2.seace.gob.pe';
const MAX_PAG    = 10;

function parsearFecha(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const c   = new Date(fechaISO); c.setHours(0, 0, 0, 0);
  return Math.round((c - hoy) / 86400000);
}

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const page = await browser.newPage();
  const licitaciones = [];

  try {
    console.log('  [SEACE PE] Abriendo portal...');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(2000);

    // Verificar que la página cargó (SEACE suele tener mantenimientos)
    const titulo = await page.title();
    if (!titulo || titulo.toLowerCase().includes('error') || titulo.toLowerCase().includes('mantenimiento')) {
      console.warn(`  [SEACE PE] Portal no disponible: "${titulo}"`);
      return licitaciones;
    }

    // Clic en el botón Buscar (JSF — puede estar oculto, usar force)
    const btnBuscar = await page.$('[id="tbBuscador:idFormbuscarACF:btnBuscarSelCCOToken"]')
                   || await page.$('[id="tbBuscador:idFormbuscarACF:btnBuscarSel"]')
                   || await page.$('button[id*="btnBuscar"]');
    if (!btnBuscar) {
      console.warn('  [SEACE PE] No se encontró botón Buscar');
      return licitaciones;
    }

    await btnBuscar.click({ force: true });
    await page.waitForTimeout(4000);

    let pagina = 1;

    while (pagina <= MAX_PAG) {
      // Extraer filas de la tabla de resultados (tabla con encabezado "Relación de Anuncios")
      const filas = await page.evaluate(() => {
        const resultados = [];
        // La tabla de resultados es la que contiene "Relación de Anuncios de Contratos"
        let tablaResultados = null;
        for (const table of document.querySelectorAll('table')) {
          if (table.textContent.includes('Relación de Anuncios') || table.textContent.includes('Objeto de la Contratación')) {
            tablaResultados = table;
            break;
          }
        }
        if (!tablaResultados) return resultados;

        const trs = Array.from(tablaResultados.querySelectorAll('tr'));
        for (const tr of trs) {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 5) continue; // necesita al menos 5 columnas de datos
          const celdas = tds.map(td => td.innerText?.trim().replace(/\s+/g, ' ') ?? '');
          // Saltar filas de encabezado
          if (celdas[0] === 'N°' || celdas[4] === 'Objeto de la Contratación') continue;
          const enlace = tr.querySelector('a');
          resultados.push({ celdas, href: enlace?.getAttribute('href') ?? null });
        }
        return resultados;
      });

      // Filtrar "No se encontraron Datos"
      const filasDatos = filas.filter(f => !f.celdas.join('').includes('No se encontraron'));

      if (filasDatos.length === 0) {
        console.log(`  [SEACE PE] Sin resultados en página ${pagina}`);
        break;
      }
      console.log(`  [SEACE PE] Página ${pagina}: ${filasDatos.length} filas`);

      for (const fila of filasDatos) {
        const c = fila.celdas;
        // Columnas: 0=N° | 1=Entidad | 2=Fecha Publicación | 3=Tipo | 4=Objeto | 5=Descripción | ... | 9=Fecha Convocatoria
        const titulo = (c[4] || c[5] || '').trim();
        if (!titulo || titulo.length < 5) continue;

        const fechaCierreStr = c[9] || c[8] || null;
        const fechaCierre    = parsearFecha(fechaCierreStr);
        const dias           = diasHastaCierre(fechaCierre);

        if (dias !== null && dias < diasCierreMin) continue;
        if (dias === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;

        const url = fila.href
          ? (fila.href.startsWith('http') ? fila.href : `${BASE}${fila.href}`)
          : PORTAL_URL;

        licitaciones.push({
          titulo,
          descripcion:       (c[5] || titulo).trim(),
          entidad:           (c[1] || 'Desconocida').trim(),
          region:            null,
          pais:              portalConfig.pais,
          portal:            portalConfig.nombre,
          url,
          fecha_publicacion: parsearFecha(c[2] || null),
          fecha_cierre:      fechaCierre,
          dias_hasta_cierre: dias,
          monto_estimado:    null, // SEACE no muestra monto en la lista pública
          moneda:            'PEN',
          numero_expediente: (c[0] || '').trim() || null,
          estado:            'En proceso',
          tipo:              (c[3] || '').trim() || null,
          _fuente:           'playwright_seace_pe'
        });
      }

      // Siguiente página
      const hayMas = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
        const sig = links.find(el => {
          const t = (el.textContent || el.value || '').trim();
          return t === 'Siguiente' || t === '>' || t === '»' || t === 'Next';
        });
        if (sig) { sig.click(); return true; }
        return false;
      });

      if (!hayMas) break;
      await page.waitForTimeout(3000);
      pagina++;
    }

  } catch (err) {
    console.warn(`  [SEACE PE] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  console.log(`  [SEACE PE] Total: ${licitaciones.length}`);
  return licitaciones;
}
