/**
 * Scraper para Licitaciones del Gobierno de Nuevo León
 * https://nl.gob.mx/es/licitaciones-dependencias-centrales
 *
 * Portal Drupal con HTML estático. Extrae los links del listado vigente
 * y visita cada página de detalle para obtener datos completos.
 */

const LISTA_URL = 'https://nl.gob.mx/es/licitaciones-dependencias-centrales';
const BASE_URL  = 'https://www.nl.gob.mx';
const MAX_ITEMS = 30;

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const c   = new Date(fechaISO + 'T00:00:00'); c.setHours(0, 0, 0, 0);
  return Math.round((c - hoy) / 86400000);
}

async function extraerDetalle(page, url, portalConfig) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800);

    return await page.evaluate((url, portalNombre, pais) => {
      const texto = document.body.innerText || '';
      const h1    = (document.querySelector('h1')?.innerText || '').trim();
      const titulo = h1 || document.title || '';

      // Número de expediente: patrón NL (ej. DGCNL-DC-LPNE-011/2026)
      const mExp = (titulo + ' ' + texto).match(/([A-Z][\w]+-[A-Z]+-LP[A-Z]+-\d+\/\d{4})/i);
      const expediente = mExp ? mExp[1].toUpperCase() : null;

      // Entidad convocante
      const mEntidad = texto.match(/(?:Organismo|Secretar[ií]a|Dependencia|Municipio|Universidad|Instituto|Consejo|Comisi[oó]n)[^\n]{0,100}/i);
      const entidad  = mEntidad
        ? mEntidad[0].replace(/\n.*/s, '').trim().slice(0, 120)
        : 'Gobierno del Estado de Nuevo León';

      // Fechas en formato "DD de mes de YYYY"
      const meses = {
        enero:'01', febrero:'02', marzo:'03', abril:'04', mayo:'05', junio:'06',
        julio:'07', agosto:'08', septiembre:'09', octubre:'10', noviembre:'11', diciembre:'12'
      };
      const fechas = [...texto.matchAll(
        /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})/gi
      )].map(f => `${f[3]}-${meses[f[2].toLowerCase()]}-${f[1].padStart(2, '0')}`);

      const fechaPub    = fechas[0] || null;
      // La última fecha mencionada suele ser el fallo/cierre
      const fechaCierre = fechas.length > 0 ? fechas[fechas.length - 1] : null;

      // Descripción: primer párrafo largo del body
      const parrafos = Array.from(document.querySelectorAll('p, .field-item'))
        .map(p => (p.innerText || '').trim())
        .filter(t => t.length > 40);
      const descripcion = parrafos[0] || titulo;

      return {
        titulo:            titulo.slice(0, 200),
        descripcion:       descripcion.slice(0, 600),
        entidad,
        region:            'Nuevo León',
        pais,
        portal:            portalNombre,
        url,
        fecha_publicacion: fechaPub,
        fecha_cierre:      fechaCierre,
        dias_hasta_cierre: null,   // se calcula en contexto Node
        monto_estimado:    null,
        moneda:            'MXN',
        numero_expediente: expediente,
        estado:            'Publicado',
        tipo:              null,
        _fuente:           'playwright_licitaciones_nl'
      };
    }, url, portalConfig.nombre, portalConfig.pais);

  } catch (err) {
    console.warn(`  [Licitaciones NL] Error detalle ${url}: ${err.message}`);
    return null;
  }
}

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const page          = await browser.newPage();
  const licitaciones  = [];

  try {
    console.log('  [Licitaciones NL] Cargando listado vigente...');
    await page.goto(LISTA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const links = await page.evaluate((base) => {
      return Array.from(document.querySelectorAll('a[href*="/convocatoria"]'))
        .map(a => ({
          texto: (a.innerText || '').trim(),
          href:  a.href.startsWith('http') ? a.href : `${base}${a.getAttribute('href')}`
        }))
        .filter(l => l.texto.length > 3);
    }, BASE_URL);

    console.log(`  [Licitaciones NL] ${links.length} convocatorias encontradas`);

    for (const { href } of links.slice(0, MAX_ITEMS)) {
      const item = await extraerDetalle(page, href, portalConfig);
      if (!item) continue;

      item.dias_hasta_cierre = diasHastaCierre(item.fecha_cierre);

      if (item.dias_hasta_cierre !== null && item.dias_hasta_cierre < diasCierreMin) continue;
      if (item.dias_hasta_cierre === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;

      licitaciones.push(item);
    }

  } catch (err) {
    console.warn(`  [Licitaciones NL] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  console.log(`  [Licitaciones NL] Total: ${licitaciones.length}`);
  return licitaciones;
}
