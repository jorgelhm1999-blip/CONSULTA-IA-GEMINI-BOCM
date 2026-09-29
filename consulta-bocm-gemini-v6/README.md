# Consulta Diaria BOCM · versión 6

Aplicación web con dos modos independientes:

- **Consulta diaria:** obtiene los CVE de los enlaces individuales del sumario oficial y consulta sus XML; Gemini clasifica los anuncios en dos etapas y resume los seleccionados.
- **Búsqueda histórica:** busca una palabra, un municipio o ambos en un intervalo de hasta 366 días. El interruptor «Aplicar criterios de interés» está encendido por defecto. Gemini revisa únicamente las coincidencias con los mismos criterios de la consulta diaria y muestra las de interés principal o complementario.

## Estructura

```text
api/search.js              API diaria existente
api/historical.js          API histórica: manifest y batch
lib/bocm.js                descubrimiento de boletines, lectura de XML y lotes
lib/historical-match.js    coincidencia literal y fragmentos resaltados
lib/gemini-bocm.js         clasificación y resumen de la consulta diaria
lib/criterios-bocm.js     criterio editorial de Gemini
app.js                    interfaz diaria
historical-ui.js           calendario y búsqueda histórica progresiva
municipalities.js         municipios para ambos modos
assets/                   cabecera
test/                     pruebas con respuestas simuladas
```

## Despliegue en GitHub y Vercel

1. Sube **el contenido de esta carpeta** a la raíz del repositorio GitHub. También puedes subir la carpeta entera; en ese caso configura **Root Directory** en Vercel como `consulta-bocm-gemini-v4`. Si el contenido está directamente en la raíz, deja Root Directory en `./`.
2. Mantén el proyecto de Vercel conectado a ese repositorio y selecciona el framework **Other**. No se requiere comando de compilación ni directorio de salida especial.
3. En **Settings → Environment Variables**, conserva `GEMINI_API_KEY` (privada) y, si se usa, `GEMINI_MODEL` (por defecto `gemini-3.1-flash-lite`). La búsqueda histórica con el interruptor apagado funciona sin estas variables; la consulta diaria y el filtro de interés sí las necesitan.
4. Despliega la nueva revisión. Comprueba `/api/historical?mode=manifest&date=2026-09-25` y una consulta diaria. No publiques claves en GitHub.

`vercel.json` fija 60 segundos como duración máxima de ambas funciones. Node.js 18 o posterior y la dependencia `cheerio` se instalan en el despliegue. No necesitas instalar Node.js en tu equipo para subir los archivos desde GitHub.

## Cómo funciona el histórico

El navegador recorre las fechas de forma secuencial. Por cada día, obtiene los enlaces XML de los anuncios de la página oficial y luego procesa grupos de hasta 12 CVE. Cada grupo descarga como máximo tres XML a la vez, busca la expresión o el municipio y entrega coincidencias y anuncios pendientes. Los fallos transitorios se reintentan; los resultados confirmados permanecen visibles. Puedes detener la búsqueda y conservar lo obtenido hasta ese momento. Un intervalo largo exige mantener abierta la pestaña.

La comparación ignora mayúsculas, tildes de vocales y diferencias de espacio; admite guiones de corte de línea. Conserva la `ñ` como letra distinta. La coincidencia es literal cuando se introduce una palabra; si se indica solo el municipio, busca su nombre en el organismo, título y texto. El interruptor decide si los anuncios encontrados pasan además por la clasificación semántica de Gemini. El calendario permite escoger y modificar inicio y fin, incluso el mismo día. Los días sin boletín se omiten.

Con el filtro activo, se usan el mismo modelo, las mismas instrucciones y las dos etapas de la consulta diaria. Solo se envían a Gemini los anuncios que coinciden con la palabra o el municipio. Los anuncios clasificados como «excluir» o «revisar» no aparecen entre las coincidencias de interés. Si Gemini no está configurado o se agota su cuota, la búsqueda se detiene con un aviso y conserva las coincidencias ya confirmadas. Este modo puede consumir cuota y aumentar sensiblemente el tiempo de las consultas amplias.

El límite de 366 días por consulta reduce el riesgo de dejar una pestaña procesando durante horas. Los resultados se muestran de 50 en 50. Las respuestas históricas idénticas pueden servirse desde caché de Vercel durante un día; las de la fecha actual se refrescan cada cinco minutos. La caché no evita descargas cuando cambian la frase o el municipio.

## Verificación local

Si dispones de Node.js en otro equipo o entorno de desarrollo:

```bash
npm ci
node --test test/integration.test.js
```

Las pruebas simulan respuestas oficiales y de Gemini. Cubren el flujo diario, días con y sin publicación, consultas de un día, semana y mes, frases y tildes, muchos resultados, ausencia de coincidencias, filtro municipal, el interruptor encendido y apagado con ofertas de empleo y régimen económico, errores transitorios y validación de fechas. Antes de dar por comprobado un despliegue, conviene contrastar una fecha real con el BOCM y verificar el calendario en escritorio y móvil.

## Limitaciones conocidas

- No existe una base de datos persistente: el progreso se conserva durante la sesión de la pestaña. Recargar la página inicia otra búsqueda.
- Los resultados son parciales si el BOCM no responde en algún día o XML; la interfaz muestra el número de pendientes.
- El algoritmo de localización de boletines parte de una estimación de su número anual. El histórico amplía el margen de búsqueda, pero cambios futuros del sitio oficial podrían requerir adaptarlo.
