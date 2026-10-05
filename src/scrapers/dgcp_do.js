/**
 * Scraper para DGCP - República Dominicana
 * https://www.dgcp.gob.do / https://comunidad.comprasdominicana.gob.do
 *
 * Usa la API REST pública de Datos Abiertos — no requiere navegador.
 * Documentación: https://datosabiertos.dgcp.gob.do/api-dgcp/docs/index.html
 *
 * Endpoint principal:
 *   GET https://datosabiertos.dgcp.gob.do/api-dgcp/v1/procesos
 *   ?estado=Proceso+publicado&limit=100&page=N
 *
 * "Proceso publicado" = licitaciones activas aceptando ofertas.
 * El campo fecha_fin_recepcion_ofertas contiene la fecha de cierre.
 */

const API_BASE = 'https://datosabiertos.dgcp.gob.do/api-dgcp/v1';
const LIMIT    = 100;   // máximo por página que soporta la API
const MAX_PAG  = 20;    // 2000 procesos máximo por ejecución

// ─── Helpers ─────────────────────────────────────────────────────────────────

function diasHastaCierre(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const c   = new Date(fechaISO); c.setHours(0, 0, 0, 0);
  return Math.round((c - hoy) / 86400000);
}

function fechaSolo(fechaISO) {
  if (!fechaISO) return null;
  return fechaISO.split('T')[0]; // "2026-05-21T14:30:00Z" → "2026-05-21"
}

async function fetchAPI(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ─── Normalizar resultado ─────────────────────────────────────────────────────

function normalizar(proceso, portalConfig) {
  const fechaCierre = fechaSolo(proceso.fecha_fin_recepcion_ofertas);

  return {
    titulo:            proceso.titulo || 'Sin título',
    descripcion:       proceso.descripcion || proceso.titulo || '',
    entidad:           proceso.unidad_compra || 'Desconocida',
    region:            null,
    pais:              portalConfig.pais,
    portal:            portalConfig.nombre,
    url:               proceso.url || `https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/Index`,
    fecha_publicacion: fechaSolo(proceso.fecha_publicacion),
    fecha_cierre:      fechaCierre,
    dias_hasta_cierre: diasHastaCierre(fechaCierre),
    monto_estimado:    proceso.monto_estimado > 0 ? proceso.monto_estimado : null,
    moneda:            proceso.divisa || 'DOP',
    numero_expediente: proceso.codigo_proceso,
    estado:            proceso.estado_proceso,
    tipo:              proceso.modalidad || null,
    _fuente:           'api_dgcp_do'
  };
}

// ─── Scraper principal ────────────────────────────────────────────────────────

export async function buscar(browser, perfil, portalConfig) {
  const diasCierreMin = perfil.filtros_fecha?.dias_cierre_min ?? 7;
  const licitaciones  = [];

  console.log('  [DGCP RD] Consultando API de Datos Abiertos...');

  let pagina = 1;

  while (pagina <= MAX_PAG) {
    const url = `${API_BASE}/procesos?estado=Proceso+publicado&limit=${LIMIT}&page=${pagina}`;

    let datos;
    try {
      datos = await fetchAPI(url);
    } catch (err) {
      console.warn(`  [DGCP RD] Error en página ${pagina}: ${err.message}`);
      break;
    }

    // La API retorna { totalResults, pages, page, limit, payload: { content: [...] } }
    const procesos = datos?.payload?.content ?? datos?.content ?? [];

    if (procesos.length === 0) break;

    console.log(`  [DGCP RD] Página ${pagina}/${datos.pages ?? '?'}: ${procesos.length} procesos`);

    for (const p of procesos) {
      const item = normalizar(p, portalConfig);

      // Filtrar por días hasta cierre
      if (item.dias_hasta_cierre !== null && item.dias_hasta_cierre < diasCierreMin) continue;
      if (item.dias_hasta_cierre === null && !perfil.filtros_fecha?.incluir_sin_fecha_cierre) continue;

      licitaciones.push(item);
    }

    // ¿Hay más páginas?
    const totalPaginas = datos.pages ?? 1;
    if (pagina >= totalPaginas) break;
    pagina++;

    // Pausa cortés para no saturar la API
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`  [DGCP RD] Total con cierre ≥${diasCierreMin}d: ${licitaciones.length}`);
  return licitaciones;
}
