/**
 * Scraper para SECOP II - Colombia
 * https://www.datos.gov.co/resource/p6dx-8zbt.json
 *
 * API Socrata pública — sin autenticación.
 * Dataset: Contratos electrónicos SECOP II (2.5M+ registros).
 * Filtro: estado_del_procedimiento = 'Publicado', últimos N días.
 *
 * No hay campo de fecha de cierre en el dataset público.
 * dias_hasta_cierre = null (requiere incluir_sin_fecha_cierre: true).
 */

const API = 'https://www.datos.gov.co/resource/p6dx-8zbt.json';
const LIMIT = 100;
const MAX_PAG = 15; // 1500 registros máximo

function fechaSolo(iso) {
  if (!iso) return null;
  return iso.split('T')[0];
}

export async function buscar(browser, perfil, portalConfig) {
  const diasPub = perfil.filtros_fecha?.dias_publicacion_max ?? 7;
  const licitaciones = [];

  const desde = new Date();
  desde.setDate(desde.getDate() - diasPub);
  const desdeISO = desde.toISOString().split('T')[0] + 'T00:00:00.000';

  console.log(`  [SECOP CO] Consultando publicaciones desde ${desdeISO.slice(0,10)}...`);

  let offset = 0;
  let pagina = 1;

  while (pagina <= MAX_PAG) {
    const params = new URLSearchParams({
      '$where': `estado_del_procedimiento='Publicado' AND fecha_de_publicacion_del >= '${desdeISO}'`,
      '$order': 'fecha_de_publicacion_del DESC',
      '$limit': LIMIT,
      '$offset': offset
    });

    let datos;
    try {
      const res = await fetch(`${API}?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      datos = await res.json();
    } catch (err) {
      console.warn(`  [SECOP CO] Error en página ${pagina}: ${err.message}`);
      break;
    }

    if (!datos.length) break;

    console.log(`  [SECOP CO] Página ${pagina}: ${datos.length} registros`);

    for (const p of datos) {
      const url = p.urlproceso?.url || p.urlproceso || null;
      licitaciones.push({
        titulo:            p.nombre_del_procedimiento || 'Sin título',
        descripcion:       [p.modalidad_de_contratacion, p.tipo_de_contrato, p.nombre_del_procedimiento].filter(Boolean).join(' — '),
        entidad:           p.entidad || 'Desconocida',
        region:            [p.departamento_entidad, p.ciudad_entidad].filter(Boolean).join(', ') || null,
        pais:              portalConfig.pais,
        portal:            portalConfig.nombre,
        url:               typeof url === 'string' ? url : 'https://community.secop.gov.co',
        fecha_publicacion: fechaSolo(p.fecha_de_publicacion_del),
        fecha_cierre:      null,   // no disponible en el dataset público
        dias_hasta_cierre: null,
        monto_estimado:    parseFloat(p.precio_base) > 0 ? parseFloat(p.precio_base) : null,
        moneda:            'COP',
        numero_expediente: p.id_del_proceso || null,
        estado:            p.estado_del_procedimiento || 'Publicado',
        tipo:              p.modalidad_de_contratacion || null,
        _fuente:           'api_secop_co'
      });
    }

    if (datos.length < LIMIT) break;
    offset += LIMIT;
    pagina++;
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`  [SECOP CO] Total registros: ${licitaciones.length}`);
  return licitaciones;
}
