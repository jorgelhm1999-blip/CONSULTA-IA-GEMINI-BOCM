# Consulta Diaria BOCM con Gemini

Esta versión conserva la localización del boletín y la descarga de sus XML,
pero sustituye el filtro determinista por una clasificación semántica mediante
la API de Gemini.

## Funcionamiento

1. Obtiene el sumario XML oficial del día.
2. Descarga los anuncios en lotes de hasta 12.
3. Primera revisión con sección, organismo y título.
4. Segunda revisión con el texto completo solo para los anuncios dudosos.
5. Devuelve los seleccionados y muestra aparte los que sigan siendo ambiguos.

No utiliza Batch API. Las consultas son normales y se responden en el momento.

## Variables de entorno en Vercel

- `GEMINI_API_KEY`: clave secreta creada en Google AI Studio.
- `GEMINI_MODEL`: opcional. Si no se configura, se usa `gemini-2.5-flash-lite`.

La clave nunca debe incluirse en GitHub ni en archivos del navegador.
Para mantener coste cero, usa un proyecto de Gemini en nivel gratuito y no
actives ni vincules facturación.

## Archivos nuevos

- `lib/criterios-bocm.js`
- `lib/gemini-bocm.js`
