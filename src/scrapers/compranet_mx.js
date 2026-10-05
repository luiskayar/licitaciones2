/**
 * Scraper para ComprasMX (antes CompraNet) - México
 * Portal renovado: https://comprasmx.buengobierno.gob.mx/sitiopublico/
 *
 * El portal es una SPA. La estrategia es navegar con Playwright e interceptar
 * las respuestas JSON que el frontend consume del backend, extrayendo los
 * procedimientos directamente de esas llamadas API sin depender del DOM.
 */

const PUBLIC_URL  = 'https://comprasmx.buengobierno.gob.mx/sitiopublico/';
const BASE_URL    = 'https://comprasmx.buengobierno.gob.mx';

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

/** Busca un campo en el objeto probando múltiples nombres posibles */
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
    'titulo', 'title', 'nombreProcedimiento', 'nombre',
    'convocatoria', 'descripcion', 'description'
  ) || '').trim();
  if (titulo.length < 5) return null;

  const entidad = String(campo(item,
    'dependencia', 'entidad', 'unidadCompradora', 'compradora',
    'nombreEntidad', 'institucion', 'organismo', 'contratante'
  ) || 'Dependencia federal').trim();

  const expediente = campo(item,
    'numeroExpediente', 'expediente', 'clave', 'folio',
    'numeroProcedimiento', 'claveExpediente', 'id'
  );

  const fechaCierre  = parsearFecha(campo(item,
    'fechaCierre', 'fechaLimiteOferta', 'fechaLimite',
    'fechaApertura', 'vencimiento', 'fechaCierreOferta'
  ));
  const fechaPub = parsearFecha(campo(item,
    'fechaPublicacion', 'fechaConvocatoria', 'fechaInicio', 'publicacion'
  ));

  const montoRaw = campo(item, 'monto', 'presupuesto', 'importe', 'valor', 'presupuestoMax');
  const monto = parseFloat(String(montoRaw || '').replace(/[^0-9.]/g, '')) || null;

  const urlItem = campo(item, 'url', 'link', 'urlDetalle', 'href');
  const url = urlItem
    ? (String(urlItem).startsWith('http') ? String(urlItem) : `${BASE_URL}${urlItem}`)
    : PUBLIC_URL;

  return {
    titulo,
    descripcion:       titulo,
    entidad,
    region:            null,
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
    tipo:              String(campo(item, 'tipo', 'tipoProcedimiento', 'modalidad') || '').trim() || null,
    _fuente:           'playwright_comprasmx_mx'
  };
}

// Términos en URLs que sugieren datos de procedimientos (no assets estáticos)
const PALABRAS_API = [
  'procedimiento', 'licitacion', 'convocatoria', 'contratacion',
  'proceso', '/api/', '/public/', '/rest/', '/busqueda', '/search'
];

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const page         = await browser.newPage();
  const licitaciones = [];

  // Cola de promesas de respuestas JSON interceptadas
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

  try {
    console.log('  [ComprasMX] Navegando al portal público...');
    await page.goto(PUBLIC_URL, { waitUntil: 'domcontentloaded', timeout: 50000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Intentar activar la sección de procedimientos/licitaciones vigentes
    const selectores = [
      'text=Procedimientos', 'text=Licitaciones', 'text=Vigentes',
      '[href*="procedimiento"]', '[href*="licitacion"]',
      'button:has-text("Buscar")', '[data-tab="procedimientos"]'
    ];
    for (const sel of selectores) {
      try {
        await page.click(sel, { timeout: 3000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        break;
      } catch {}
    }

    // Espera final para dar tiempo a requests asíncronos
    await page.waitForTimeout(2000);

  } catch (err) {
    console.warn(`  [ComprasMX] Error de navegación: ${err.message}`);
  } finally {
    await page.close();
  }

  // Procesar respuestas capturadas
  const respuestas = (await Promise.all(colaRespuestas)).filter(Boolean);
  console.log(`  [ComprasMX] APIs interceptadas: ${respuestas.length}`);

  for (const { url, json } of respuestas) {
    const items =
      json.data        || json.results      || json.content    ||
      json.procedimientos || json.licitaciones || json.convocatorias ||
      (Array.isArray(json) ? json : []);

    if (!Array.isArray(items) || items.length === 0) continue;

    console.log(`  [ComprasMX] ${items.length} registros en ${url}`);

    for (const item of items) {
      const lic = normalizarItem(item, portalConfig);
      if (!lic) continue;
      if (lic.dias_hasta_cierre !== null && lic.dias_hasta_cierre < diasCierreMin) continue;
      if (lic.dias_hasta_cierre === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;
      licitaciones.push(lic);
    }
  }

  if (respuestas.length === 0) {
    console.log('  [ComprasMX] Sin APIs JSON capturadas — el portal puede necesitar ajuste de selectores');
  }

  console.log(`  [ComprasMX] Total: ${licitaciones.length}`);
  return licitaciones;
}
