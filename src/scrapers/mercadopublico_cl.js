/**
 * Scraper para Mercado Público - Chile
 * https://www.mercadopublico.cl
 *
 * Estrategia (2 pasos para eficiencia):
 *   1. Listar licitaciones por fecha → solo trae CodigoExterno, Nombre, FechaCierre (~400/día)
 *   2. Pre-filtrar por título con keywords → solo pedir detalle de las candidatas
 *   3. Obtener detalle completo (Organismo, Descripción, Categoría) de las candidatas
 *   4. Aplicar score de relevancia final
 *
 * API docs:  https://api.mercadopublico.cl
 * Ticket demo público (ChileCompra): F8537A18-6766-4DEF-9E59-426B4FEE2844
 *   → Compartido, tiene rate-limit. Reintentos automáticos con backoff.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fechaAPI(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}${m}${date.getFullYear()}`;
}

function toISO(isoString) {
  if (!isoString) return null;
  return isoString.split('T')[0];
}

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const cierre = new Date(fechaISO); cierre.setHours(0, 0, 0, 0);
  return Math.round((cierre - hoy) / 86400000);
}

// ─── HTTP con reintentos ──────────────────────────────────────────────────────

/**
 * fetch con reintentos exponenciales para manejar el 429 del ticket compartido
 */
async function fetchRetry(url, intentosMax = 5) {
  for (let i = 0; i < intentosMax; i++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'DELPHOS-LicitacionesBot/1.0 (lumana@deinsa.com)' },
        signal: AbortSignal.timeout(25000)
      });
    } catch (err) {
      if (i === intentosMax - 1) throw err;
      await sleep((i + 1) * 2000);
      continue;
    }

    if (res.status === 429) {
      const espera = (i + 1) * 4000; // 4s, 8s, 12s…
      console.log(`    ⏳ Rate limit (429) — reintento ${i + 1}/${intentosMax - 1} en ${espera / 1000}s`);
      await sleep(espera);
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return res;
  }
  throw new Error(`Máximo de reintentos alcanzado para: ${url}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── API: listar licitaciones por fecha ──────────────────────────────────────

/**
 * Obtiene el listado mínimo (CodigoExterno, Nombre, FechaCierre) de un día
 * La API devuelve todos en una sola página (sin paginación real en el listado por fecha)
 */
async function listarPorFecha(ticket, fecha) {
  const url = `https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json`
    + `?ticket=${ticket}&fecha=${fecha}&estado=publicada`;

  const res = await fetchRetry(url);
  const data = await res.json();
  return data.Listado ?? [];
}

// ─── API: detalle de una licitación ──────────────────────────────────────────

/**
 * Obtiene el detalle completo de una licitación por su CodigoExterno
 * Campos útiles: Descripcion, Comprador, Fechas, MontoEstimado, Items
 */
async function obtenerDetalle(ticket, codigo) {
  const url = `https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json`
    + `?ticket=${ticket}&codigo=${encodeURIComponent(codigo)}`;

  const res = await fetchRetry(url);
  const data = await res.json();
  return data.Listado?.[0] ?? null;
}

// ─── Pre-filtro rápido por título ─────────────────────────────────────────────

/**
 * Verifica si una keyword aparece como palabra completa (word-boundary).
 * Evita que "SIG" coincida con "consignación", "BI" con "adquisición", etc.
 */
/** Elimina acentos y pasa a minúsculas: "Gestión" → "gestion" */
function normalizar(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchKeyword(texto, kw) {
  // Normalizar ambos (sin acentos) para que "gestión" == "gestion"
  const t = normalizar(texto);
  const k = normalizar(kw);
  const escaped = k.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
  const letra = '[a-zA-Z0-9_]';
  const regex = new RegExp('(?<!' + letra + ')' + escaped + '(?!' + letra + ')', 'i');
  return regex.test(t);
}

/**
 * Pre-filtro ligero: términos simples (sin acentos) para pasar de 400/día
 * a ~30 candidatas que luego se consultan en detalle.
 * Intencional: es amplio. El scoring final elimina los falsos positivos.
 */
const PREFILTRO_POSITIVOS = [
  'software', 'plataforma', 'licenci', 'sistema de gestion', 'gestion de riesgo',
  'riesgo operativo', 'cumplimiento', 'gobernanza', 'auditoria', 'compliance',
  'grc', 'cobit', 'continuidad del negocio', 'continuidad de negocio',
  'seguridad de la informacion', 'ciberseguridad', 'sevri',
  'planificacion estrategica', 'desempeno institucional',
  'control interno', 'gestion institucional'
];

const PREFILTRO_EXCLUSIONES = [
  'aseo', 'limpieza', 'alimento', 'vivere', 'vehiculo', 'combustible',
  'medicamento', 'quirurgico', 'stent', 'valvula', 'catetere', 'implante',
  'protesis', 'uniforme', 'vestuario', 'mobiliario', 'silla', 'escritorio',
  'papeleria', 'toner', 'impresora', 'jardineria', 'vigilancia', 'seguridad fisica',
  'construccion', 'obras civil', 'infraestructura vial', 'transporte de persona',
  'evento', 'publicidad impresa', 'imprenta', 'calefaccion', 'climatizacion',
  'incendio', 'iluminacion estadio', 'calzado', 'jeringas', 'insumos medico',
  'dispositivos medicos', 'hemodinamia', 'oftalmologico', 'enfermeria', 'suministro'
];

function prefiltroPorTitulo(nombre, _perfil) {
  const t = normalizar(nombre);
  const letra = '[a-zA-Z0-9_]';

  // Excluir primero
  for (const ex of PREFILTRO_EXCLUSIONES) {
    const esc = ex.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
    if (new RegExp('(?<!' + letra + ')' + esc + '(?!' + letra + ')', 'i').test(t)) return false;
    // Para exclusiones de substring parcial (como "quirurgico" en "quirurgicos")
    if (t.includes(ex)) return false;
  }

  // Aceptar si hay algún término positivo
  return PREFILTRO_POSITIVOS.some(pos => t.includes(pos));
}

// ─── Normalización ────────────────────────────────────────────────────────────

/**
 * Convierte un objeto detalle de la API al formato interno del motor
 */
function normalizarDetalle(detalle, portalConfig) {
  const fechaCierre = toISO(detalle.Fechas?.FechaCierre ?? detalle.FechaCierre);
  const fechaPublicacion = toISO(detalle.Fechas?.FechaPublicacion);

  // Categoría del primer item (muy útil para contexto)
  const categoria = detalle.Items?.Listado?.[0]?.Categoria ?? null;

  return {
    titulo: detalle.Nombre ?? 'Sin título',
    descripcion: [
      detalle.Descripcion ?? '',
      categoria ? `Categoría: ${categoria}` : ''
    ].filter(Boolean).join(' | ').slice(0, 600),
    entidad: detalle.Comprador?.NombreOrganismo ?? 'Desconocida',
    region: detalle.Comprador?.RegionUnidad?.trim() ?? null,
    pais: portalConfig.pais,
    portal: portalConfig.nombre,
    url: `https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?qs=${detalle.CodigoExterno}`,
    fecha_publicacion: fechaPublicacion,
    fecha_cierre: fechaCierre,
    dias_hasta_cierre: Number(detalle.DiasCierreLicitacion) || diasHastaCierre(fechaCierre),
    monto_estimado: detalle.MontoEstimado ?? null,
    moneda: detalle.Moneda ?? 'CLP',
    numero_expediente: detalle.CodigoExterno,
    estado: detalle.Estado ?? null,
    tipo: detalle.Tipo ?? null,
    _fuente: 'api_mercadopublico_cl'
  };
}

// ─── Flujo principal ──────────────────────────────────────────────────────────

export async function buscar(browser, perfil, portalConfig) {
  const ticket = portalConfig.api_ticket?.trim();
  const diasAtras = perfil.filtros_fecha?.dias_publicacion_max ?? 7;
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;

  if (!ticket) {
    console.log('  [Chile] Sin ticket API — saltando (configurar api_ticket en portales.json)');
    return [];
  }

  console.log(`  [Chile] Buscando publicaciones de los últimos ${diasAtras} días...`);

  // ── Paso 1: recolectar listados de todos los días ──────────────────────────
  const candidatasBase = []; // { CodigoExterno, Nombre, FechaCierre }
  const hoy = new Date();

  for (let i = 0; i < diasAtras; i++) {
    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() - i);
    const fechaStr = fechaAPI(fecha);

    try {
      const items = await listarPorFecha(ticket, fechaStr);
      console.log(`  [Chile] ${fechaStr}: ${items.length} licitaciones publicadas`);
      candidatasBase.push(...items);
    } catch (err) {
      console.warn(`  [Chile] Error listando ${fechaStr}: ${err.message}`);
    }

    // Pausa entre días — el ticket demo es compartido, ser respetuoso
    if (i < diasAtras - 1) await sleep(2500);
  }

  // ── Paso 2: pre-filtrar por título (evita pedir detalle de lo obviamente irrelevante) ──
  const preSeleccionadas = candidatasBase.filter(item =>
    prefiltroPorTitulo(item.Nombre ?? '', perfil)
  );

  console.log(`  [Chile] Pre-filtro: ${candidatasBase.length} → ${preSeleccionadas.length} candidatas (${Math.round(preSeleccionadas.length / Math.max(candidatasBase.length, 1) * 100)}%)`);

  if (preSeleccionadas.length === 0) return [];

  // ── Paso 3: obtener detalle de cada candidata ──────────────────────────────
  const licitaciones = [];

  for (let idx = 0; idx < preSeleccionadas.length; idx++) {
    const item = preSeleccionadas[idx];

    try {
      const detalle = await obtenerDetalle(ticket, item.CodigoExterno);
      if (!detalle) continue;

      const normalizada = normalizarDetalle(detalle, portalConfig);

      // Filtrar por días hasta cierre
      const dias = normalizada.dias_hasta_cierre;
      if (dias !== null && dias < diasCierreMin) continue;
      if (dias === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;

      licitaciones.push(normalizada);
    } catch (err) {
      console.warn(`  [Chile] Error en detalle ${item.CodigoExterno}: ${err.message}`);
    }

    // Pausa entre detalles — ticket compartido, evitar ráfagas
    if (idx < preSeleccionadas.length - 1) await sleep(1800);

    // Progreso cada 10
    if ((idx + 1) % 10 === 0) {
      console.log(`  [Chile] Detalles: ${idx + 1}/${preSeleccionadas.length}...`);
    }
  }

  console.log(`  [Chile] Licitaciones con cierre ≥${diasCierreMin}d: ${licitaciones.length}`);
  return licitaciones;
}
