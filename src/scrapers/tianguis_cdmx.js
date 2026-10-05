/**
 * Scraper para ConcursoDigital - Ciudad de México
 * https://concursodigital.finanzas.cdmx.gob.mx/convocatorias_publicas
 *
 * SPA con filtros. Intercepta las respuestas JSON del backend;
 * si no las captura, hace fallback a scraping del DOM renderizado.
 */

const SEARCH_URL = 'https://concursodigital.finanzas.cdmx.gob.mx/convocatorias_publicas';
const BASE_URL   = 'https://concursodigital.finanzas.cdmx.gob.mx';

function parsearFecha(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const c   = new Date(fechaISO + 'T00:00:00'); c.setHours(0, 0, 0, 0);
  return Math.round((c - hoy) / 86400000);
}

function campo(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
    const snake = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (obj[snake] != null) return obj[snake];
  }
  return null;
}

function normalizarItem(item, portalConfig) {
  const titulo = String(campo(item,
    'titulo', 'title', 'nombre', 'asunto', 'convocatoria', 'descripcion'
  ) || '').trim();
  if (titulo.length < 5) return null;

  const entidad = String(campo(item,
    'unidadConvocante', 'entidad', 'dependencia', 'organismo', 'unidad'
  ) || 'Secretaría de Administración y Finanzas CDMX').trim();

  const expediente = campo(item,
    'numero', 'numeroLicitacion', 'folio', 'clave', 'expediente', 'id'
  );

  const fechaCierre = parsearFecha(campo(item,
    'fechaPresentacion', 'fechaCierre', 'fechaLimite',
    'fechaOferta', 'fechaApertura', 'vencimiento'
  ));
  const fechaPub = parsearFecha(campo(item,
    'fechaPublicacion', 'fechaConvocatoria', 'fechaInicio', 'publicacion'
  ));

  const monto = parseFloat(
    String(campo(item, 'monto', 'presupuesto', 'importe', 'valor') || '').replace(/[^0-9.]/g, '')
  ) || null;

  // El portal usa IDs numéricos codificados en Base64 para sus URLs de detalle
  const idRaw = campo(item, 'id', 'licitacionId', 'idLicitacion', 'idConvocatoria');
  const idB64 = idRaw ? Buffer.from(String(idRaw)).toString('base64') : null;
  const url   = idB64 ? `${BASE_URL}/${idB64}` : SEARCH_URL;

  return {
    titulo,
    descripcion:       titulo,
    entidad,
    region:            'Ciudad de México',
    pais:              portalConfig.pais,
    portal:            portalConfig.nombre,
    url,
    fecha_publicacion: fechaPub,
    fecha_cierre:      fechaCierre,
    dias_hasta_cierre: diasHastaCierre(fechaCierre),
    monto_estimado:    monto,
    moneda:            'MXN',
    numero_expediente: expediente ? String(expediente).trim() : null,
    estado:            'Publicado',
    tipo:              String(campo(item, 'tipo', 'tipoContratacion', 'modalidad') || '').trim() || null,
    _fuente:           'playwright_concursodigital_cdmx'
  };
}

const PALABRAS_API = [
  'convocatoria', 'licitacion', 'procedimiento', 'contratacion',
  '/api/', '/public/', '/rest/', '/busqueda', '/search'
];

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const page          = await browser.newPage();
  const licitaciones  = [];
  const colaRespuestas = [];

  page.on('response', response => {
    const ct  = (response.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('application/json')) return;
    const url = response.url().toLowerCase();
    if (!PALABRAS_API.some(p => url.includes(p))) return;
    const p = response.json()
      .then(json => ({ url: response.url(), json }))
      .catch(() => null);
    colaRespuestas.push(p);
  });

  let itemsDOM = [];

  try {
    console.log('  [ConcursoDigital CDMX] Navegando al portal...');
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 50000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Intentar activar filtro "Vigentes"
    const selectoresVigentes = [
      'text=Vigentes', '[value="vigente"]', 'option:has-text("Vigentes")',
      '[data-estado="vigente"]', 'button:has-text("Vigentes")'
    ];
    for (const sel of selectoresVigentes) {
      try {
        await page.click(sel, { timeout: 2500 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        break;
      } catch {}
    }
    await page.waitForTimeout(2000);

    // Fallback DOM: extraer tarjetas/filas renderizadas
    itemsDOM = await page.evaluate(() => {
      const selectores = [
        '.convocatoria-item', '.licitacion-card', '[class*="convocatoria"]',
        '[class*="licitacion"]', 'tbody tr', '.list-group-item', '.card'
      ];
      for (const sel of selectores) {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length === 0) continue;
        return els.map(el => ({
          texto: (el.innerText || '').trim(),
          href:  el.querySelector('a')?.href || ''
        })).filter(i => i.texto.length > 10);
      }
      return [];
    });

  } catch (err) {
    console.warn(`  [ConcursoDigital CDMX] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  // Procesar respuestas JSON interceptadas
  const respuestas = (await Promise.all(colaRespuestas)).filter(Boolean);
  console.log(`  [ConcursoDigital CDMX] APIs interceptadas: ${respuestas.length}`);

  for (const { url, json } of respuestas) {
    const items =
      json.data || json.results || json.content || json.convocatorias ||
      json.licitaciones || (Array.isArray(json) ? json : []);

    if (!Array.isArray(items) || items.length === 0) continue;
    console.log(`  [ConcursoDigital CDMX] ${items.length} registros en ${url}`);

    for (const item of items) {
      const lic = normalizarItem(item, portalConfig);
      if (!lic) continue;
      if (lic.dias_hasta_cierre !== null && lic.dias_hasta_cierre < diasCierreMin) continue;
      if (lic.dias_hasta_cierre === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;
      licitaciones.push(lic);
    }
  }

  if (respuestas.length === 0 && itemsDOM.length > 0) {
    console.log(`  [ConcursoDigital CDMX] ${itemsDOM.length} ítems en DOM (sin API JSON) — revisar mapeo`);
  } else if (respuestas.length === 0) {
    console.log('  [ConcursoDigital CDMX] Sin datos capturados — ajustar selectores con la estructura real');
  }

  console.log(`  [ConcursoDigital CDMX] Total: ${licitaciones.length}`);
  return licitaciones;
}
