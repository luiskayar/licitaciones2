/**
 * Motor de búsqueda de licitaciones para DELPHOS.
 *
 * Lógica pura, sin console.log: reporta su avance a través de un callback
 * `onEvent({ type, message, progress, data })` para que tanto el CLI
 * (src/index.js) como el servidor web (src/server.js) puedan reusarla.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analizarConGemini } from './analista-gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

const PESO_PORTALES = 70;
const PESO_IA = 30;

/**
 * Ejecuta una búsqueda completa: recorre los portales activos, prefiltra
 * por keywords, analiza con Gemini y guarda los resultados nuevos en disco.
 *
 * @param {(evento: {type:string, message:string, progress?:number, data?:object}) => void} onEvent
 * @returns {Promise<{resumen: object, nuevas: object[], relevantes: object[], archivo: string|null}>}
 */
export async function ejecutarBusqueda(onEvent = () => {}) {
  const perfil         = JSON.parse(readFileSync(join(ROOT, 'config/delphos-perfil.json'), 'utf8'));
  const portalesConfig = JSON.parse(readFileSync(join(ROOT, 'config/portales.json'), 'utf8'));
  const iaConfig        = JSON.parse(readFileSync(join(ROOT, 'config/ia.json'), 'utf8'));
  if (process.env.GEMINI_API_KEY) {
    iaConfig.gemini = { ...iaConfig.gemini, api_key: process.env.GEMINI_API_KEY };
  }

  const emit = (type, message, extra = {}) => onEvent({ type, message, ...extra });

  emit('inicio', `Fecha: ${new Date().toLocaleString('es-CR')}`);

  const resultados = [];
  const portalesActivos = portalesConfig.portales.filter(p => p.activo);

  if (portalesActivos.length === 0) {
    emit('sin-portales', 'No hay portales activos configurados todavía.', { progress: 100 });
    return { resumen: null, nuevas: [], relevantes: [], archivo: null };
  }

  const necesitaBrowser = portalesActivos.some(p => p.modo === 'playwright');
  let browser = null;
  if (necesitaBrowser) {
    emit('navegador', 'Iniciando navegador Chromium...', { progress: 1 });
    browser = await chromium.launch({ headless: true });
  }

  try {
    for (let i = 0; i < portalesActivos.length; i++) {
      const portal = portalesActivos[i];
      const progresoBase = Math.round((i / portalesActivos.length) * PESO_PORTALES);
      emit('portal-inicio', `Buscando en: ${portal.nombre} (${portal.pais})`, {
        progress: progresoBase,
        data: { portal: portal.nombre, index: i + 1, total: portalesActivos.length }
      });
      try {
        const scraper = await import(`./scrapers/${portal.id}.js`);
        const encontradas = await scraper.buscar(browser, perfil, portal);
        resultados.push(...encontradas);
        emit('portal-fin', `${encontradas.length} licitaciones encontradas en ${portal.nombre}`, {
          progress: Math.round(((i + 1) / portalesActivos.length) * PESO_PORTALES),
          data: { portal: portal.nombre, count: encontradas.length }
        });
      } catch (err) {
        emit('portal-error', `Error en ${portal.nombre}: ${err.message}`, {
          progress: Math.round(((i + 1) / portalesActivos.length) * PESO_PORTALES),
          data: { portal: portal.nombre, error: err.message }
        });
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  const candidatas = prefiltrarCandidatas(resultados, perfil);
  emit('prefiltro', `Candidatas para análisis IA: ${candidatas.length} de ${resultados.length}`, {
    progress: PESO_PORTALES,
    data: { candidatas: candidatas.length, total: resultados.length }
  });

  let relevantes;
  if (iaConfig.gemini?.activo && iaConfig.gemini?.api_key !== 'xxx') {
    const maxPorLote = iaConfig.gemini.max_por_lote ?? 10;
    const totalLotes = Math.max(1, Math.ceil(candidatas.length / maxPorLote));
    relevantes = await analizarConGemini(candidatas, iaConfig, (lote, total) => {
      emit('ia-lote', `Gemini analizando lote ${lote}/${total}...`, {
        progress: PESO_PORTALES + Math.round((lote / total) * PESO_IA),
        data: { lote, total }
      });
    });
  } else {
    emit('ia-sin-config', 'Gemini no configurado — usando filtro de keywords', { progress: PESO_PORTALES });
    relevantes = filtrarPorRelevancia(candidatas, perfil);
  }

  const vistas = cargarVistas();
  const nuevas = relevantes.filter(l => !vistas.has(claveUnica(l)));
  const duplicadas = relevantes.length - nuevas.length;

  const archivo = guardarResultados(nuevas);
  actualizarVistas(vistas, nuevas);

  const resumen = {
    portalesRevisados: portalesActivos.length,
    totalAnalizadas: resultados.length,
    candidatas: candidatas.length,
    relevantes: relevantes.length,
    duplicadas,
    nuevas: nuevas.length,
    archivo
  };

  emit('fin', `Búsqueda completa: ${nuevas.length} licitaciones nuevas`, { progress: 100, data: resumen });

  return { resumen, nuevas, relevantes, archivo };
}

/**
 * Pre-filtro amplio: descarta lo obviamente irrelevante (física, alimentos, etc.)
 * y deja pasar todo lo que tenga algo de TI/gestión para que Gemini decida.
 */
function prefiltrarCandidatas(licitaciones, perfil) {
  return licitaciones.filter(l => {
    const texto = `${l.titulo} ${l.descripcion || ''}`;
    const t = normalizar(texto);

    for (const ex of perfil.exclusiones) {
      if (matchKeyword(texto, ex)) return false;
    }

    const todasKeywords = [
      ...perfil.palabras_clave.alta_prioridad,
      ...perfil.palabras_clave.media_prioridad,
      ...perfil.palabras_clave.baja_prioridad
    ];
    if (todasKeywords.some(kw => matchKeyword(texto, kw))) return true;

    const terminosTI = ['software','plataforma','sistema','licenci','gestion','riesgo',
      'cumplimiento','gobernanza','auditoria','control','desempeno','estrategica',
      'indicador','monitoreo','evaluacion','compliance','digital'];
    return terminosTI.some(t2 => t.includes(t2));
  });
}

/**
 * Keywords que definen el núcleo GRC de DELPHOS.
 * Si ninguna de estas aparece en el texto, la licitación se descarta
 * aunque acumule puntos con términos genéricos de TI.
 */
const NUCLEO_GRC = [
  'GRC', 'SEVRI', 'COBIT', 'ISO 31000', 'ISO 27001', 'ISO 22301',
  'riesgo operativo', 'riesgos operativos',
  'gestión de riesgos', 'administración de riesgos', 'sistema de gestión de riesgos',
  'continuidad del negocio', 'continuidad de negocio', 'plan de continuidad',
  'cumplimiento normativo', 'control interno', 'gobernanza corporativa',
  'gobierno corporativo', 'autoevaluación de control', 'gobierno de TI',
  'planificación estratégica institucional', 'PEI', 'PETIC'
];

/** Normaliza texto eliminando acentos para comparación robusta */
function normalizar(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchKeyword(texto, kw) {
  const t = normalizar(texto);
  const k = normalizar(kw);
  const escaped = k.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
  const letra = '[a-zA-Z0-9_]';
  const regex = new RegExp('(?<!' + letra + ')' + escaped + '(?!' + letra + ')', 'i');
  return regex.test(t);
}

function filtrarPorRelevancia(licitaciones, perfil) {
  return licitaciones
    .map(l => {
      const texto = `${l.titulo} ${l.descripcion || ''}`.toLowerCase();
      let puntuacion = 0;

      for (const excluida of perfil.exclusiones) {
        if (matchKeyword(texto, excluida)) return null;
      }

      for (const kw of perfil.palabras_clave.alta_prioridad) {
        if (matchKeyword(texto, kw)) puntuacion += 10;
      }
      for (const kw of perfil.palabras_clave.media_prioridad) {
        if (matchKeyword(texto, kw)) puntuacion += 5;
      }
      for (const kw of perfil.palabras_clave.baja_prioridad) {
        if (matchKeyword(texto, kw)) puntuacion += 2;
      }

      const minimo = perfil.umbrales_relevancia?.minimo_para_incluir ?? 2;
      if (puntuacion < minimo) return null;

      const tieneNucleoGRC = NUCLEO_GRC.some(kw => matchKeyword(texto, kw));
      if (!tieneNucleoGRC) return null;

      const umbrales = perfil.umbrales_relevancia ?? { alta: 10, media: 5 };
      const nivel = puntuacion >= umbrales.alta ? 'ALTA'
        : puntuacion >= umbrales.media ? 'MEDIA'
        : 'BAJA';

      return { ...l, puntuacion, nivel_relevancia: nivel };
    })
    .filter(Boolean)
    .sort((a, b) => b.puntuacion - a.puntuacion);
}

function claveUnica(l) {
  if (l._fuente && l.numero_expediente) return `${l._fuente}|${l.numero_expediente}`;
  return l.url;
}

function cargarVistas() {
  const archivo = join(ROOT, 'data/history/licitaciones-vistas.json');
  if (!existsSync(archivo)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(archivo, 'utf8')));
  } catch {
    return new Set();
  }
}

function actualizarVistas(vistas, nuevas) {
  const archivo = join(ROOT, 'data/history/licitaciones-vistas.json');
  mkdirSync(join(ROOT, 'data/history'), { recursive: true });
  nuevas.forEach(l => vistas.add(claveUnica(l)));
  writeFileSync(archivo, JSON.stringify([...vistas], null, 2), 'utf8');
}

function guardarResultados(resultados) {
  const fecha = new Date().toISOString().split('T')[0];
  const archivo = join(ROOT, `data/results/licitaciones-${fecha}.json`);
  mkdirSync(join(ROOT, 'data/results'), { recursive: true });
  writeFileSync(archivo, JSON.stringify(resultados, null, 2), 'utf8');
  return `data/results/licitaciones-${fecha}.json`;
}
