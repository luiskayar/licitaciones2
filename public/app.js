const els = {
  bannerError: document.getElementById('banner-error'),
  panelProgreso: document.getElementById('panel-progreso'),
  progresoEstado: document.getElementById('progreso-estado'),
  progresoPct: document.getElementById('progreso-pct'),
  progresoFill: document.getElementById('progreso-fill'),
  progresoLog: document.getElementById('progreso-log'),
  btnBuscar: document.getElementById('btn-buscar'),
  btnJson: document.getElementById('btn-json'),
  btnPdf: document.getElementById('btn-pdf'),
  selectFecha: document.getElementById('select-fecha'),
  statsResumen: document.getElementById('stats-resumen'),
  filtroTexto: document.getElementById('filtro-texto'),
  filtroNivel: document.getElementById('filtro-nivel'),
  resultados: document.getElementById('resultados'),
  sinResultados: document.getElementById('sin-resultados'),
  tplCard: document.getElementById('tpl-card')
};

const state = {
  fecha: null,
  licitaciones: [],
  nivel: 'TODAS',
  texto: ''
};

function mostrarError(mensaje) {
  els.bannerError.textContent = `⚠️ ${mensaje}`;
  els.bannerError.hidden = false;
}

function ocultarError() {
  els.bannerError.hidden = true;
}

// ─── Carga de resultados guardados ────────────────────────────────────────────

async function cargarListaFechas(seleccionar) {
  try {
    const res = await fetch('/api/resultados');
    if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
    const lista = await res.json();

    els.selectFecha.innerHTML = '';
    if (lista.length === 0) {
      els.selectFecha.innerHTML = '<option value="">Sin búsquedas todavía</option>';
      els.resultados.innerHTML = '';
      els.statsResumen.textContent = '';
      return;
    }

    for (const item of lista) {
      const opt = document.createElement('option');
      opt.value = item.fecha;
      opt.textContent = `${item.fecha} · ${item.total} resultado(s)`;
      els.selectFecha.appendChild(opt);
    }

    const fechaFinal = seleccionar && lista.some(l => l.fecha === seleccionar)
      ? seleccionar
      : lista[0].fecha;
    els.selectFecha.value = fechaFinal;
    await cargarFecha(fechaFinal);
  } catch (err) {
    mostrarError(`No se pudo cargar la lista de resultados: ${err.message}`);
  }
}

async function cargarFecha(fecha) {
  try {
    const res = await fetch(`/api/resultados/${fecha}`);
    if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
    state.fecha = fecha;
    state.licitaciones = await res.json();
    ocultarError();
    actualizarStats();
    renderizar();
  } catch (err) {
    mostrarError(`No se pudo cargar la búsqueda del ${fecha}: ${err.message}`);
  }
}

function actualizarStats() {
  const l = state.licitaciones;
  const alta = l.filter(x => x.nivel_relevancia === 'ALTA').length;
  const media = l.filter(x => x.nivel_relevancia === 'MEDIA').length;
  const baja = l.filter(x => x.nivel_relevancia === 'BAJA').length;
  els.statsResumen.innerHTML = `<b>${l.length}</b> total · <b>${alta}</b> alta · <b>${media}</b> media · <b>${baja}</b> baja`;
}

// ─── Render de tarjetas ────────────────────────────────────────────────────────

function renderizar() {
  const texto = state.texto.trim().toLowerCase();
  const filtradas = state.licitaciones.filter(l => {
    if (state.nivel !== 'TODAS' && l.nivel_relevancia !== state.nivel) return false;
    if (!texto) return true;
    const haystack = `${l.titulo} ${l.entidad} ${l.pais} ${l.portal}`.toLowerCase();
    return haystack.includes(texto);
  });

  els.resultados.innerHTML = '';
  els.sinResultados.hidden = filtradas.length > 0;

  for (const l of filtradas) {
    const nodo = els.tplCard.content.cloneNode(true);
    const nivel = (l.nivel_relevancia || 'BAJA').toLowerCase();

    const badge = nodo.querySelector('.badge');
    badge.textContent = l.nivel_relevancia || '—';
    badge.classList.add(`badge-${nivel}`);

    nodo.querySelector('.card-titulo').textContent = l.titulo;
    nodo.querySelector('.card-entidad').textContent =
      `${l.entidad}${l.region ? ' — ' + l.region : ''} · ${l.pais} · ${l.portal}`;

    const monto = l.monto_estimado
      ? `${l.moneda || ''} ${Number(l.monto_estimado).toLocaleString('es-CL')}`
      : 'Monto no publicado';
    const cierre = l.dias_hasta_cierre != null
      ? `${l.fecha_cierre} (faltan ${l.dias_hasta_cierre} días)`
      : (l.fecha_cierre || 'Sin fecha de cierre');
    nodo.querySelector('.card-montocierre').textContent = `💰 ${monto}  ·  📅 ${cierre}`;

    const razon = nodo.querySelector('.card-razon');
    if (l.razon_gemini) {
      razon.textContent = `🤖 ${l.razon_gemini}`;
    } else {
      razon.remove();
    }

    const link = nodo.querySelector('.card-link');
    link.href = l.url;

    els.resultados.appendChild(nodo);
  }
}

// ─── Filtros ───────────────────────────────────────────────────────────────

els.filtroTexto.addEventListener('input', (e) => {
  state.texto = e.target.value;
  renderizar();
});

els.filtroNivel.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  document.querySelectorAll('#filtro-nivel .pill').forEach(p => p.classList.remove('pill-active'));
  btn.classList.add('pill-active');
  state.nivel = btn.dataset.nivel;
  renderizar();
});

els.selectFecha.addEventListener('change', (e) => cargarFecha(e.target.value));

// ─── Descargas ─────────────────────────────────────────────────────────────

els.btnJson.addEventListener('click', () => {
  if (!state.fecha) return;
  window.location.href = `/api/resultados/${state.fecha}/descargar`;
});

els.btnPdf.addEventListener('click', async () => {
  if (!state.fecha) return;
  els.btnPdf.disabled = true;
  const textoOriginal = els.btnPdf.textContent;
  els.btnPdf.textContent = 'Generando PDF…';
  try {
    const res = await fetch(`/api/resultados/${state.fecha}/pdf`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `El servidor respondió ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `licitaciones-${state.fecha}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    mostrarError(`No se pudo generar el PDF: ${err.message}`);
  } finally {
    els.btnPdf.disabled = false;
    els.btnPdf.textContent = textoOriginal;
  }
});

// ─── Búsqueda en vivo (SSE) ────────────────────────────────────────────────

function agregarLinea(texto, clase) {
  const div = document.createElement('div');
  if (clase) div.classList.add(clase);
  const hora = new Date().toLocaleTimeString('es-CR');
  div.textContent = `[${hora}] ${texto}`;
  els.progresoLog.appendChild(div);
  els.progresoLog.scrollTop = els.progresoLog.scrollHeight;
}

function fijarProgreso(pct) {
  const valor = Math.max(0, Math.min(100, pct ?? 0));
  els.progresoFill.style.width = `${valor}%`;
  els.progresoPct.textContent = `${valor}%`;
}

function iniciarBusquedaUI() {
  els.panelProgreso.hidden = false;
  els.progresoLog.innerHTML = '';
  els.progresoEstado.textContent = 'Buscando licitaciones…';
  fijarProgreso(0);
  els.btnBuscar.disabled = true;
  els.btnBuscar.textContent = '⏳ Buscando…';
  ocultarError();
}

function finalizarBusquedaUI(ok, mensaje) {
  els.progresoEstado.textContent = mensaje;
  els.btnBuscar.disabled = false;
  els.btnBuscar.textContent = '🔍 Ejecutar búsqueda ahora';
  if (!ok) mostrarError(mensaje);
}

function manejarEvento(evento) {
  switch (evento.type) {
    case 'server-estado':
      if (evento.estado === 'ejecutando') iniciarBusquedaUI();
      return;
    case 'server-inicio':
      iniciarBusquedaUI();
      return;
    case 'server-fin':
      fijarProgreso(100);
      finalizarBusquedaUI(true, '✅ Búsqueda completada');
      cargarListaFechas(evento.data?.archivo ? soloFecha(evento.data.archivo) : undefined);
      return;
    case 'server-error':
      finalizarBusquedaUI(false, `❌ ${evento.message}`);
      return;
  }

  if (typeof evento.progress === 'number') fijarProgreso(evento.progress);
  if (evento.message) {
    const clase = evento.type === 'portal-error' ? 'log-error'
      : evento.type === 'fin' ? 'log-ok'
      : undefined;
    agregarLinea(evento.message, clase);
  }
}

function soloFecha(archivo) {
  const m = archivo.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

function conectarSSE() {
  const fuente = new EventSource('/api/buscar/eventos');
  fuente.onmessage = (e) => {
    try {
      manejarEvento(JSON.parse(e.data));
    } catch {
      // ignorar mensajes mal formados
    }
  };
  fuente.onerror = () => {
    // EventSource reintenta solo; no es necesario mostrar error por cada corte breve
  };
}

els.btnBuscar.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/buscar', { method: 'POST' });
    if (res.status === 409) {
      const body = await res.json();
      mostrarError(body.error);
      return;
    }
    if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
    iniciarBusquedaUI();
  } catch (err) {
    mostrarError(`No se pudo iniciar la búsqueda: ${err.message}`);
  }
});

// ─── Arranque ──────────────────────────────────────────────────────────────

cargarListaFechas();
conectarSSE();
