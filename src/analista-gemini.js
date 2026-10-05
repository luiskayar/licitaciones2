/**
 * Analista de licitaciones con Gemini
 *
 * Reemplaza el filtro de keywords por análisis real con IA.
 * Gemini lee cada licitación con el contexto de DELPHOS y decide
 * si es una oportunidad real — igual que lo haría un humano.
 *
 * Modelo: gemini-2.0-flash (rápido y económico para tareas operativas)
 * Costo estimado: ~$0.01 por ejecución completa (35 licitaciones)
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Prompt del analista ──────────────────────────────────────────────────────

const SISTEMA = `Eres un analista de desarrollo de negocios para DELPHOS, una plataforma SaaS de GRC (Gobierno, Riesgo y Cumplimiento) desarrollada por DEINSA Global para el sector público y financiero de América Latina.

DELPHOS tiene módulos para:
- Gestión de Riesgos Operativos (ISO 31000, SEVRI de Costa Rica)
- Continuidad del Negocio (ISO 22301, BCP, PCN)
- Seguridad de la Información (ISO 27001, ciberseguridad)
- Gobernanza de TI (COBIT 2019, ITIL)
- Planificación Estratégica (PEI, PAO, PETIC, BSC)
- Control Interno y Autoevaluación (COSO, INTOSAI)
- Gestión del Desempeño e Indicadores (KPI, Balanced Scorecard)
- Cumplimiento Normativo y Regulatorio

Clientes típicos: ministerios, instituciones autónomas, municipalidades, bancos públicos, cooperativas, superintendencias, poder judicial, contraloría.

Tu tarea: analizar licitaciones públicas y determinar si DELPHOS podría ser el producto que están buscando.

RELEVANTE (responder true) si la licitación busca:
- Software, plataforma o sistema para GRC, riesgos, cumplimiento, gobernanza, control
- Herramientas de planificación estratégica institucional (PEI, PAO, BSC, KPI)
- Sistemas de gestión del desempeño o indicadores institucionales
- Plataformas de seguridad de la información o continuidad de negocio
- Software que cubra total o parcialmente lo que DELPHOS ofrece
- Consultoría + implementación de software GRC (aunque incluya servicios)

NO RELEVANTE (responder false) si busca:
- Hardware, infraestructura física, servidores, redes, telecomunicaciones
- Software de contabilidad, ERP financiero, nóminas, RRHH puro
- Servicios de consultoría sin componente de software a licenciar
- Bienes físicos, construcción, equipos, vehículos
- Software muy específico no relacionado (gestión documental pura, trámites ciudadanos)

Responde SOLO con un array JSON válido, sin markdown, sin explicaciones adicionales.`;

// ─── Llamada a la API ─────────────────────────────────────────────────────────

async function llamarGemini(apiKey, modelo, prompt) {
  const url = `${ENDPOINT}/${modelo}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: SISTEMA }] },
    generationConfig: {
      temperature: 0.1,       // Baja creatividad — queremos análisis consistente
      responseMimeType: 'application/json'
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';

  try {
    return JSON.parse(texto);
  } catch {
    // A veces Gemini envuelve en markdown aunque se pida JSON — limpiar
    const limpio = texto.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(limpio);
  }
}

// ─── Análisis por lotes ───────────────────────────────────────────────────────

/**
 * Analiza un lote de licitaciones con Gemini.
 * Retorna un array con los mismos objetos enriquecidos con análisis de IA.
 *
 * @param {object[]} licitaciones - Array de licitaciones pre-filtradas
 * @param {object} iaConfig - Contenido de config/ia.json
 * @param {(lote:number, totalLotes:number) => void} [onProgress] - Callback opcional por lote
 * @returns {Promise<object[]>} - Solo las relevantes según Gemini
 */
export async function analizarConGemini(licitaciones, iaConfig, onProgress = () => {}) {
  const { api_key, modelo, max_por_lote = 10 } = iaConfig.gemini;

  if (!api_key || api_key === 'xxx') {
    console.log('  [Gemini] Sin API key configurada — usando solo filtro de keywords');
    return [];
  }

  console.log(`  [Gemini] Analizando ${licitaciones.length} candidatas con ${modelo}...`);

  const relevantes = [];
  const lotes = [];

  // Dividir en lotes
  for (let i = 0; i < licitaciones.length; i += max_por_lote) {
    lotes.push(licitaciones.slice(i, i + max_por_lote));
  }

  for (let li = 0; li < lotes.length; li++) {
    const lote = lotes[li];
    console.log(`  [Gemini] Lote ${li + 1}/${lotes.length} (${lote.length} licitaciones)...`);
    onProgress(li + 1, lotes.length);

    // Construir el prompt con las licitaciones del lote
    const listaTexto = lote.map((l, idx) => {
      const monto = l.monto_estimado
        ? ` | Monto: ${l.moneda} ${Number(l.monto_estimado).toLocaleString()}`
        : '';
      return `${idx + 1}. TÍTULO: ${l.titulo}
   ENTIDAD: ${l.entidad} (${l.pais})
   DESCRIPCIÓN: ${l.descripcion || 'No disponible'}
   CIERRE: ${l.fecha_cierre || 'No especificado'} (${l.dias_hasta_cierre ?? '?'} días)${monto}`;
    }).join('\n\n');

    const prompt = `Analiza estas ${lote.length} licitaciones y determina cuáles son oportunidades para DELPHOS.

${listaTexto}

Responde con un array JSON con este formato exacto para cada licitación:
[
  {
    "id": 1,
    "relevante": true,
    "nivel": "ALTA",
    "razon": "Busca plataforma de gestión de riesgos con ISO 31000"
  },
  {
    "id": 2,
    "relevante": false,
    "nivel": null,
    "razon": "Es compra de hardware de red"
  }
]`;

    try {
      const resultados = await llamarGemini(api_key, modelo, prompt);

      // Enriquecer las licitaciones con el análisis de Gemini
      for (const resultado of resultados) {
        const idx = resultado.id - 1;
        if (idx < 0 || idx >= lote.length) continue;
        if (!resultado.relevante) continue;

        relevantes.push({
          ...lote[idx],
          nivel_relevancia: resultado.nivel ?? 'MEDIA',
          puntuacion: resultado.nivel === 'ALTA' ? 90 : resultado.nivel === 'MEDIA' ? 60 : 30,
          razon_gemini: resultado.razon,
          _analizado_por: 'gemini'
        });
      }

    } catch (err) {
      console.warn(`  [Gemini] Error en lote ${li + 1}: ${err.message}`);
    }

    // Pausa entre lotes para no saturar la API
    if (li < lotes.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const alta = relevantes.filter(l => l.nivel_relevancia === 'ALTA').length;
  const media = relevantes.filter(l => l.nivel_relevancia === 'MEDIA').length;
  console.log(`  [Gemini] Resultado: ${relevantes.length} relevantes (${alta} ALTA, ${media} MEDIA)`);

  return relevantes.sort((a, b) => b.puntuacion - a.puntuacion);
}
