/**
 * Scraper para PanamaCompra - Panamá
 * https://www.panamacompra.gob.pa
 *
 * PanamaCompra es un SPA Angular. El endpoint de búsqueda ASMX
 * requiere la sesión inicializada por Angular antes de funcionar.
 *
 * Estrategia:
 *  1. Navegar a la página de búsqueda avanzada.
 *  2. Cerrar el modal de anuncios que bloquea interacciones.
 *  3. Seleccionar Estado = Vigente e interceptar la primera respuesta ASMX.
 *  4. Paginar con page.evaluate() usando el cursor Consecutivo
 *     (la sesión ya está establecida tras la primera llamada exitosa).
 *
 * La lista no expone fecha de cierre → dias_hasta_cierre queda en null.
 * Requiere incluir_sin_fecha_cierre: true en el perfil.
 */

const PORTAL_URL  = 'https://www.panamacompra.gob.pa/Inicio/';
const SEARCH_URL  = 'https://www.panamacompra.gob.pa/Inicio/#/busqueda-avanzada-v2';
const ASMX_PATH   = '/Security/AmbientePublico.asmx/ListarActosParametros';
const DETALLE_URL = 'https://www.panamacompra.gob.pa/Inicio/#!/vistaPreviaCP?NumLc={NUM}&esap=1&nnc=0&it=1';
const MAX_PAG     = 30;   // máximo de páginas a recorrer

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parsearFecha(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function normalizarActo(acto, portalConfig) {
  const num = acto.NumeroAdquisicion || '';
  const url = num
    ? DETALLE_URL.replace('{NUM}', encodeURIComponent(num))
    : PORTAL_URL;

  return {
    titulo:            (acto.DescripcionAdquisicion || 'Sin descripción').trim(),
    descripcion:       [acto.modalidad, acto.DescripcionAdquisicion].filter(Boolean).join(' — '),
    entidad:           [acto.NombreUnidadCompra, acto.NombreDependencia].filter(Boolean).join(' / ') || 'Desconocida',
    region:            null,
    pais:              portalConfig.pais,
    portal:            portalConfig.nombre,
    url,
    fecha_publicacion: parsearFecha(acto.fecha),
    fecha_cierre:      null,      // no disponible en la lista
    dias_hasta_cierre: null,      // "Vigente" = abierto por definición
    monto_estimado:    acto.MontoRef > 0 ? acto.MontoRef : null,
    moneda:            'PAB',     // Balboa = 1:1 USD
    numero_expediente: num || null,
    estado:            acto.Estado || 'Vigente',
    tipo:              acto.modalidad || null,
    _fuente:           'playwright_panamacompra'
  };
}

// ─── Llamada ASMX paginada (desde el contexto del navegador) ──────────────────

async function llamarAsmx(page, inicio) {
  return page.evaluate(async ({ path, inicio }) => {
    const valor = {
      descripcion: '', estado: 2, provincia: 0, tcompra: -1,
      fd: Date.now() - 90 * 86400000,
      fh: Date.now() + 5  * 86400000,
      ucompra: {}, entidad: null, dependencia: null, proponente: null, sbo: null,
      BusquedaAvanzada: true, esNumLc: false,
      Inicio: inicio
    };
    const body = 'METHOD=0&VALUE=' + encodeURIComponent(JSON.stringify(valor));
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        credentials: 'include'
      });
      if (!res.ok) return { error: res.status };
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  }, { path: ASMX_PATH, inicio });
}

// ─── Scraper principal ────────────────────────────────────────────────────────

export async function buscar(browser, perfil, portalConfig) {
  const page = await browser.newPage();
  const licitaciones = [];

  // Interceptar la primera respuesta ASMX para saber que la sesión está lista
  let sesionLista = false;
  const primeraRespuesta = new Promise((resolve) => {
    page.on('response', async (resp) => {
      if (!sesionLista && resp.url().includes('ListarActosParametros') && resp.status() === 200) {
        sesionLista = true;
        const json = await resp.json().catch(() => null);
        resolve(json);
      }
    });
  });

  try {
    // ── 1. Cargar la SPA ──────────────────────────────────────────────────
    console.log('  [PanamaCompra] Cargando portal Angular...');
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 50000 });
    await page.waitForTimeout(3000);

    // ── 2. Cerrar modal de anuncios si está presente ───────────────────────
    const modal = await page.$('ngb-modal-window, .modal.show');
    if (modal) {
      console.log('  [PanamaCompra] Cerrando modal de anuncios...');
      // Intentar botón ×/Cerrar dentro del modal
      const btnCerrar = await page.$('ngb-modal-window button.close, ngb-modal-window button[aria-label="Close"], ngb-modal-window .btn-close');
      if (btnCerrar) {
        await btnCerrar.click({ force: true });
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(1000);
    }

    // ── 3. Seleccionar Estado = Vigente e iniciar búsqueda ─────────────────
    console.log('  [PanamaCompra] Seleccionando Estado = Vigente...');
    await page.selectOption('select#estado', { label: 'Vigente' });
    await page.waitForTimeout(500);

    // Clic en el primer botón Buscar visible y habilitado
    const btnBuscar = await page.$('.btn-blue-dark:not([disabled])');
    if (btnBuscar) {
      await btnBuscar.click({ force: true }); // force ignora el modal si sigue parcialmente visible
      console.log('  [PanamaCompra] Búsqueda iniciada — esperando respuesta ASMX...');
    } else {
      console.warn('  [PanamaCompra] No se encontró botón Buscar');
      return licitaciones;
    }

    // ── 4. Esperar primera respuesta (timeout 20s) ────────────────────────
    const primera = await Promise.race([
      primeraRespuesta,
      new Promise(r => setTimeout(() => r(null), 20000))
    ]);

    if (!primera || !primera.listActos) {
      // Fallback: intentar llamada directa (puede que la sesión esté lista)
      console.log('  [PanamaCompra] Sin respuesta interceptada — intentando llamada directa...');
      const directa = await llamarAsmx(page, '');
      if (!directa || directa.error || !directa.listActos) {
        console.warn(`  [PanamaCompra] API no disponible: ${directa?.error ?? 'sin datos'}`);
        return licitaciones;
      }
      // Procesar respuesta directa
      for (const acto of directa.listActos) {
        licitaciones.push(normalizarActo(acto, portalConfig));
      }
      // Paginar con llamadas directas
      let inicio = directa.Consecutivo || '';
      let isNext = directa.isNext ?? directa.IsNext ?? 0;
      let pagina = 2;
      while (isNext && inicio && pagina <= MAX_PAG) {
        console.log(`  [PanamaCompra] Página ${pagina}...`);
        const res = await llamarAsmx(page, inicio);
        if (!res || res.error || !res.listActos?.length) break;
        for (const acto of res.listActos) licitaciones.push(normalizarActo(acto, portalConfig));
        isNext = res.isNext ?? res.IsNext ?? 0;
        inicio = res.Consecutivo || '';
        pagina++;
        await new Promise(r => setTimeout(r, 1200));
      }
      console.log(`  [PanamaCompra] Total licitaciones vigentes: ${licitaciones.length}`);
      return licitaciones;
    }

    // ── 5. Procesar primera página ────────────────────────────────────────
    console.log(`  [PanamaCompra] Página 1: ${primera.listActos.length} actos`);
    for (const acto of primera.listActos) {
      licitaciones.push(normalizarActo(acto, portalConfig));
    }

    // ── 6. Paginar con llamadas directas (sesión ya establecida) ──────────
    let inicio = primera.Consecutivo || '';
    let isNext  = primera.isNext ?? primera.IsNext ?? 0;
    let pagina  = 2;

    while (isNext && inicio && pagina <= MAX_PAG) {
      console.log(`  [PanamaCompra] Página ${pagina}...`);
      const res = await llamarAsmx(page, inicio);
      if (!res || res.error || !res.listActos?.length) break;
      console.log(`  [PanamaCompra] Página ${pagina}: ${res.listActos.length} actos`);
      for (const acto of res.listActos) licitaciones.push(normalizarActo(acto, portalConfig));
      isNext = res.isNext ?? res.IsNext ?? 0;
      inicio = res.Consecutivo || '';
      pagina++;
      await new Promise(r => setTimeout(r, 1200));
    }

  } catch (err) {
    console.warn(`  [PanamaCompra] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  console.log(`  [PanamaCompra] Total licitaciones vigentes: ${licitaciones.length}`);
  return licitaciones;
}
