# Auditoría y cambios · Consulta Diaria BOCM v6

## Cambios v6

- El manifiesto diario e histórico recoge solo enlaces a XML individuales de la vista completa oficial. El anterior barrido de texto del sumario podía incluir una referencia adicional que no era un anuncio. El 29/09/2026 la vista oficial enumera 60 anuncios; la prueba simulada incluye deliberadamente una referencia `-0` ajena a los anuncios y verifica que se excluye.
- La búsqueda histórica acepta municipio sin palabra. El interruptor de interés aparece encendido de inicio; al apagarlo se muestran todas las coincidencias municipales, incluidas las que Gemini excluiría.
- El fondo azul claro permite distinguir visualmente el despliegue v6. Se conserva el desglose de días y anuncios no comprobados de v4.2.

## Nuevo filtro opcional del histórico

El interruptor se inicia encendido. El servidor aplica `analyzeBocmRecords()` únicamente a los XML que coinciden con la palabra o el municipio; esa es la misma clasificación en dos etapas y con los mismos criterios de la consulta diaria. Solo se muestran decisiones `principal` y `complementario`. La respuesta de cada lote indica el modo en su URL, por lo que la caché del modo libre no se mezcla con la del filtrado. Si Gemini falla o falta la clave, la interfaz detiene el recorrido y conserva los resultados confirmados. Este modo consume cuota de Gemini y puede prolongar los tiempos de búsqueda.

## Errores reales observados en los archivos recibidos

| Hallazgo | Archivo | Cambio aplicado |
| --- | --- | --- |
| El endpoint histórico llamaba a una función que devolvía siempre `disabled: true`. | `api/historical.js`, `lib/bocm.js` | Endpoint por sumario y lotes XML, con búsqueda literal independiente de Gemini. |
| Si un lote diario fallaba, la interfaz sustituía los resultados recibidos por un mensaje genérico. | `app.js` | Conserva y muestra las tarjetas parciales con un aviso. |
| Dos funciones antiguas usaban `ai.resumen` sin definir `ai`. | `lib/bocm.js` | Sustituido por su resumen local en esas funciones; su clasificación antigua sigue sin intervenir en el flujo diario activo. |
| Las URL oficiales se insertaban en atributos HTML sin validar. | `app.js` | Se admiten únicamente enlaces HTTPS a `bocm.es` y `www.bocm.es`, escapados para HTML. |
| Un fallo temporal al localizar boletines podía confundirse con un día sin publicación. | `lib/bocm.js` | Se informa como error reintentable; los 404 y días genuinamente vacíos siguen devolviendo ausencia de boletín. |
| La fecha actual dependía del huso horario del navegador y de la representación local de `en-CA`. | `app.js`, `historical-ui.js`, `api/search.js`, `api/historical.js` | Fecha de Madrid extraída con `formatToParts`; validación de fechas imposibles. |

## Riesgos razonables detectados

- **Tiempo de Gemini en la consulta diaria:** los reintentos de hasta 45 segundos por petición y dos etapas podrían agotar el máximo de 60 segundos de una función de Vercel en una saturación prolongada. Se conserva esta lógica porque la versión actual funciona; la interfaz ya retiene los lotes completados.
- **Localización del número del boletín:** la consulta diaria prueba una estimación con margen de cuatro números. El histórico amplía el margen a doce y limita el tiempo de sus peticiones. Un cambio del formato o la numeración oficial requeriría adaptar el descubrimiento.
- **Municipio:** el filtro examina también el texto completo, como hacía la versión diaria; un anuncio que mencione incidentalmente otro municipio podría aparecer al filtrarlo. Revisar el organismo y el fragmento en casos dudosos.
- **Caché:** funciona para peticiones idénticas a Vercel. No hay repositorio persistente de todos los XML; una frase nueva puede requerir repetir sus descargas.

## Código conservado y mejoras opcionales

La consulta diaria usa la vista oficial del sumario para identificar XML individuales, lotes de CVE, `analyzeBocmRecords()` y la clasificación de Gemini en dos etapas. La lista de municipios y la cabecera se han conservado. `searchBocm()` y `searchBocmBatch()` contienen rutas antiguas no usadas por las dos API actuales; no se han eliminado para evitar alterar otros usos que no figuran en el proyecto recibido.

Una futura versión podría almacenar un índice persistente de XML ya descargados y permitir retomar una búsqueda tras cerrar la pestaña. Para búsquedas repetidas de años completos, eso reduciría considerablemente el tráfico al BOCM.

## Pruebas realizadas

- `node --test test/integration.test.js`: pruebas superadas; incluye día con y sin BOCM, un día, semana, mes, frase, tildes, búsqueda vacía, 73 coincidencias, municipio, error temporal y reintento de XML, consulta diaria y filtro histórico de Gemini simulados y validación de fechas/CVE. Los anuncios de empleo y régimen económico que contienen «Alcobendas» se muestran con el interruptor apagado y se excluyen al encenderlo.
- Simulación DOM de la interfaz: cambio de modo, calendario de inicio/fin y edición del rango, mismo día, paginación, marcado del fragmento y cambio del interruptor con 72 resultados libres y 6 filtrados: correcto.
- Comprobación de sintaxis de los módulos JavaScript: correcta.
- La página oficial del BOCM enlaza el sumario XML con la estructura utilizada en `lib/bocm.js`. La verificación automatizada se ha hecho con respuestas simuladas: **no se ha ejecutado una consulta real de extremo a extremo contra el BOCM ni Gemini en Vercel**.

## Archivos modificados o añadidos

- Modificados: `index.html`, `app.js`, `styles.css`, `api/search.js`, `api/historical.js`, `lib/bocm.js`, `vercel.json`, `package.json`, `README.md`.
- Añadidos: `historical-ui.js`, `lib/historical-match.js`, `package-lock.json`, `test/integration.test.js`, `AUDITORIA.md`.
- Conservados: `municipalities.js`, `lib/gemini-bocm.js`, `lib/criterios-bocm.js`, `assets/cabecera-consulta-diaria-bocm.png`.
