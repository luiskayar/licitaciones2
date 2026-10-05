# Scrapers por Portal

Cada scraper es un módulo ES que exporta una función `buscar(browser, perfil, portalConfig)`.

## Estructura de un scraper

```js
export async function buscar(browser, perfil, portalConfig) {
  const page = await browser.newPage();
  const licitaciones = [];

  // 1. Navegar al portal
  await page.goto(portalConfig.url_busqueda);

  // 2. Aplicar filtros de búsqueda (palabras clave, categorías, fechas)
  // 3. Extraer resultados
  // 4. Retornar array de objetos con esta forma:

  licitaciones.push({
    titulo: 'Nombre del concurso',
    descripcion: 'Descripción breve',
    entidad: 'Institución convocante',
    pais: portalConfig.pais,
    portal: portalConfig.nombre,
    url: 'URL directa al expediente',
    fecha_publicacion: '2026-05-11',
    fecha_cierre: '2026-06-01',
    monto_estimado: null,
    numero_expediente: 'XX-YYYY-ZZZZ'
  });

  await page.close();
  return licitaciones;
}
```

## Scrapers pendientes de construir

- [ ] `sicop_cr.js` — SICOP Costa Rica (Luis debe dar instrucciones)
- [ ] `guatecompras.js` — GuateCompras Guatemala
- [ ] `honducompras.js` — HonduCompras Honduras
- [ ] `comprasal.js` — ComprasAL El Salvador
- [ ] `panama_compras.js` — PanamaCompra Panamá

## Cómo agregar un nuevo portal

1. Agregar entrada en `config/portales.json` con `"activo": true`
2. Crear `src/scrapers/<id>.js` con la función `buscar`
3. Ejecutar `npm run explorar <url>` para mapear el portal visualmente
