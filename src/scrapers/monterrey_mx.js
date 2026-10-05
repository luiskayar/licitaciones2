/**
 * Scraper para Licitaciones del Municipio de Monterrey
 * https://www.monterrey.gob.mx/transparencia/Convocatorias.html
 *
 * Portal municipal con HTML estático. Publica convocatorias como texto/PDF.
 * Extrae títulos, expedientes y fechas de los ítems de la página de convocatorias.
 */

const CONVOCATORIAS_URL = 'https://www.monterrey.gob.mx/transparencia/Convocatorias.html';
const BASE_URL          = 'https://www.monterrey.gob.mx';

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const c   = new Date(fechaISO + 'T00:00:00'); c.setHours(0, 0, 0, 0);
  return Math.round((c - hoy) / 86400000);
}

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const page          = await browser.newPage();
  const licitaciones  = [];

  try {
    console.log('  [Monterrey MX] Cargando convocatorias...');
    await page.goto(CONVOCATORIAS_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2000);

    const items = await page.evaluate((baseUrl) => {
      const resultados = [];

      // El portal municipal publica convocatorias como links o texto en secciones
      // Intentamos distintos selectores según la estructura del portal
      const selectores = [
        'a[href*="convocatoria"]', 'a[href*="licitacion"]',
        'a[href*=".pdf"]', 'a[href*="transparencia"]',
        'li a', 'td a', '.field-item a', 'article a'
      ];

      // Recolectar todos los links candidatos
      const linksVistos = new Set();
      for (const sel of selectores) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          const href  = a.href || a.getAttribute('href') || '';
          const texto = (a.innerText || a.textContent || '').trim();
          if (!href || linksVistos.has(href)) continue;
          linksVistos.add(href);

          // Incluir link si su texto o URL tiene palabras relacionadas con licitaciones
          const hayPalabra = /licitaci[oó]n|convocatoria|lici|adquisici[oó]n|servicio|contrataci[oó]n/i.test(texto + href);
          if (!hayPalabra || texto.length < 5) continue;

          // Texto del contenedor padre para capturar contexto (fechas, número, etc.)
          const contexto = (a.closest('li, tr, div, p')?.innerText || '').trim().slice(0, 300);

          // Número de expediente en el texto (patrón municipal: SA-DA/NN/YYYY o LP-NNNN-YYYY)
          const mExp = (texto + ' ' + contexto).match(
            /([A-Z]{2,}-[A-Z]{2,}\/\d+\/\d{4}|LP-\d+-\w+-\d+|\d{4}-\w+-\d+)/i
          );

          // Fechas en formato "DD/MM/YYYY" o "DD-MM-YYYY"
          const fechas = [...(texto + ' ' + contexto).matchAll(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/g)]
            .map(f => `${f[3]}-${f[2]}-${f[1]}`);

          resultados.push({
            titulo:    texto.slice(0, 200),
            contexto,
            href:      href.startsWith('http') ? href : `${baseUrl}${href}`,
            expediente: mExp ? mExp[1] : null,
            fechas
          });
        }
      }

      // Si no hay links específicos, intentar extraer bloques de texto de secciones
      if (resultados.length === 0) {
        const bloques = Array.from(document.querySelectorAll('h3, h4, .title, .convocatoria'))
          .map(el => (el.innerText || '').trim())
          .filter(t => t.length > 10);
        for (const bloque of bloques) {
          resultados.push({
            titulo: bloque.slice(0, 200),
            contexto: bloque,
            href: baseUrl,
            expediente: null,
            fechas: []
          });
        }
      }

      return resultados;
    }, BASE_URL);

    console.log(`  [Monterrey MX] ${items.length} ítems encontrados`);

    for (const item of items) {
      const fechaCierre = item.fechas.length > 0
        ? item.fechas[item.fechas.length - 1]   // última fecha = probable cierre
        : null;
      const dias = diasHastaCierre(fechaCierre);

      if (dias !== null && dias < diasCierreMin) continue;
      if (dias === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;

      licitaciones.push({
        titulo:            item.titulo,
        descripcion:       item.contexto.slice(0, 600) || item.titulo,
        entidad:           'Municipio de Monterrey',
        region:            'Nuevo León',
        pais:              portalConfig.pais,
        portal:            portalConfig.nombre,
        url:               item.href,
        fecha_publicacion: item.fechas[0] || null,
        fecha_cierre:      fechaCierre,
        dias_hasta_cierre: dias,
        monto_estimado:    null,
        moneda:            'MXN',
        numero_expediente: item.expediente,
        estado:            'Publicado',
        tipo:              null,
        _fuente:           'playwright_monterrey_mx'
      });
    }

    if (items.length === 0) {
      console.log('  [Monterrey MX] Sin ítems — el portal puede haber cambiado su estructura');
    }

  } catch (err) {
    console.warn(`  [Monterrey MX] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  console.log(`  [Monterrey MX] Total: ${licitaciones.length}`);
  return licitaciones;
}
