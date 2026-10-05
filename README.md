# DELPHOS — Motor de Búsqueda de Licitaciones

Motor automatizado con Playwright para identificar licitaciones públicas relevantes para **DELPHOS GRC** en portales de compras de América Latina.

## Estructura del proyecto

```
delphos-licitaciones/
├── config/
│   ├── delphos-perfil.json    # Palabras clave y criterios de DELPHOS
│   └── portales.json          # Portales de compras y sus configuraciones
├── src/
│   ├── index.js               # Orquestador principal
│   ├── explorador.js          # Herramienta para mapear portales manualmente
│   └── scrapers/
│       ├── README.md          # Instrucciones para crear scrapers
│       ├── sicop_cr.js        # [pendiente] SICOP Costa Rica
│       └── ...                # Un archivo por portal
├── data/
│   ├── results/               # Resultados JSON por fecha
│   └── history/               # Historial de licitaciones vistas
└── playwright.config.js
```

## Configuración

Copia `.env.example` a `.env` y coloca ahí tu `GEMINI_API_KEY` real. Nunca la pongas directamente en `config/ia.json` (ese archivo solo debe tener el placeholder `"xxx"`) — `.env` está excluido de git en `.gitignore`.

## Comandos

```bash
# Levantar el dashboard web en http://localhost:3000
npm run dev

# Ejecutar búsqueda en todos los portales activos (CLI, sin interfaz web)
npm run buscar

# Abrir un portal visualmente para explorar su estructura
npm run explorar https://www.sicop.go.cr

# Generar código Playwright grabando acciones en el navegador
npm run codegen https://www.sicop.go.cr
```

## Flujo de trabajo

1. **Explorar portal** (`npm run explorar <url>`) — Navegar visualmente para entender la estructura
2. **Grabar acciones** (`npm run codegen <url>`) — Playwright graba automáticamente el código
3. **Crear scraper** — Guardar el scraper en `src/scrapers/<id>.js`
4. **Activar portal** — Poner `"activo": true` en `config/portales.json`
5. **Ejecutar** (`npm run buscar`) — Resultados en `data/results/`

## Despliegue (Render / Railway)

Esta app necesita un **proceso persistente** (Playwright, la barra de progreso en vivo y el guardado de resultados dependen de eso) — **no funciona en Vercel** tal como está construida, porque Vercel corre funciones serverless de corta duración sin disco propio. Usa Render, Railway, Fly.io o un VPS.

Pasos generales (aplican a Render y Railway):

1. **Build command**: `npm install` (el hook `postinstall` ya descarga Chromium para Playwright automáticamente)
2. **Start command**: `npm start`
3. **Variables de entorno** (configúralas en el dashboard de la plataforma, no subas `.env`):
   - `GEMINI_API_KEY` — tu API key de Gemini
   - `PORT` — normalmente la inyecta la plataforma automáticamente, no hace falta configurarla a mano
4. **Disco persistente**: sin un volumen/disco persistente configurado en la plataforma, los archivos que se escriben en `data/results/` y `data/history/` durante una búsqueda en vivo se pierden en el próximo redeploy o reinicio (aunque sobreviven mientras la instancia siga corriendo). Si te importa conservar el historial entre despliegues, agrega un disco persistente montado en `data/` (ambas plataformas lo ofrecen) o commitea los JSON nuevos al repo periódicamente.

## Configuración pendiente

Luis debe completar:
- [ ] `config/delphos-perfil.json` — Ajustar palabras clave según criterios reales de DELPHOS
- [ ] `config/portales.json` — Confirmar URLs de búsqueda por portal
- [ ] `src/scrapers/` — Crear scraper para cada portal con instrucciones de navegación
