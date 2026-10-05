/**
 * CLI del motor de búsqueda de licitaciones para DELPHOS.
 * Orquesta los scrapers por portal, filtra resultados relevantes e imprime
 * el resumen en consola. La lógica vive en src/buscador.js para poder
 * reusarla desde el servidor web (src/server.js).
 */

import { ejecutarBusqueda } from './buscador.js';

async function main() {
  console.log('=== DELPHOS — Motor de Búsqueda de Licitaciones ===\n');

  const { relevantes, resumen } = await ejecutarBusqueda((evento) => {
    switch (evento.type) {
      case 'inicio':
        console.log(evento.message + '\n');
        break;
      case 'navegador':
        console.log('🌐 ' + evento.message);
        break;
      case 'sin-portales':
        console.log('⚠️  ' + evento.message);
        break;
      case 'portal-inicio':
        console.log(`🔍 ${evento.message}`);
        break;
      case 'portal-fin':
        console.log(`   ✓ ${evento.message}`);
        break;
      case 'portal-error':
        console.log(`   ✗ ${evento.message}`);
        break;
      case 'prefiltro':
        console.log(`\n🤖 ${evento.message}`);
        break;
      case 'ia-sin-config':
        console.log(`  [IA] ${evento.message}`);
        break;
      case 'ia-lote':
        // ya lo imprime analista-gemini.js con más detalle
        break;
      default:
        break;
    }
  });

  if (!resumen) return;

  console.log(`\n📊 Resumen:`);
  console.log(`   Portales revisados: ${resumen.portalesRevisados}`);
  console.log(`   Total licitaciones analizadas: ${resumen.totalAnalizadas}`);
  console.log(`   Candidatas enviadas a Gemini: ${resumen.candidatas}`);
  console.log(`   ✅ Relevantes para DELPHOS: ${resumen.relevantes}`);
  if (resumen.duplicadas > 0) console.log(`   🔄 Ya detectadas antes (omitidas): ${resumen.duplicadas}`);
  console.log(`   🆕 Nuevas en este archivo: ${resumen.nuevas}`);
  console.log(`\n💾 Resultados guardados en: ${resumen.archivo}`);

  if (relevantes.length > 0) {
    console.log('\n🎯 Oportunidades para DELPHOS:');
    relevantes.forEach((l, i) => {
      const cierre = l.dias_hasta_cierre != null
        ? `${l.fecha_cierre} (faltan ${l.dias_hasta_cierre} días)`
        : (l.fecha_cierre || 'sin fecha');
      const monto = l.monto_estimado
        ? `${l.moneda || ''} ${Number(l.monto_estimado).toLocaleString('es-CL')}`
        : 'monto no publicado';
      console.log(`\n  ${i + 1}. [${l.nivel_relevancia}] ${l.titulo}`);
      console.log(`     🏛  ${l.entidad}${l.region ? ' — ' + l.region : ''}`);
      console.log(`     💰 ${monto} | 📅 Cierre: ${cierre}`);
      if (l.razon_gemini) console.log(`     🤖 ${l.razon_gemini}`);
      if (l.numero_expediente) console.log(`     📋 Expediente: ${l.numero_expediente}`);
      console.log(`     🔗 ${l.url}`);
    });
  } else {
    console.log('\n  Sin oportunidades esta búsqueda — se revisará mañana automáticamente.');
  }
}

main().catch(console.error);