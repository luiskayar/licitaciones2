/**
 * Herramienta interactiva para explorar un portal manualmente con Playwright
 * Útil para mapear la estructura de un portal antes de construir su scraper
 *
 * Uso: node src/explorador.js <url>
 * Ejemplo: node src/explorador.js https://www.sicop.go.cr
 */

import { chromium } from 'playwright';

const url = process.argv[2];

if (!url) {
  console.log('Uso: node src/explorador.js <url-del-portal>');
  console.log('Ejemplo: node src/explorador.js https://www.sicop.go.cr');
  process.exit(1);
}

async function explorar() {
  console.log(`Abriendo navegador en: ${url}`);
  console.log('El navegador se abre en modo visible para que puedas explorar...\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });

  const page = await browser.newPage();

  page.on('response', async (response) => {
    const reqUrl = response.url();
    if (reqUrl.includes('api') || reqUrl.includes('search') || reqUrl.includes('buscar')) {
      console.log(`[API detectada] ${response.status()} ${reqUrl}`);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Página cargada. Inspecciona el navegador y presiona Ctrl+C cuando termines.');
  console.log('Tip: usa las DevTools del navegador para identificar selectores CSS relevantes.\n');

  // Mantener el navegador abierto
  await new Promise(() => {});
}

explorar().catch(console.error);
