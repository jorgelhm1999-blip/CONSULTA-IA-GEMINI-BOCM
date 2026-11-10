# Consulta diaria: descarga y análisis separados

La web y el workflow utilizan `lib/query-client.js`. Ambos consultan el mismo despliegue de producción; usar otra URL/proyecto puede separar la caché.

1. `manifest`: relación oficial de CVE, caché de 5 minutos; no guardar resultados negativos.
2. `download`: hasta 4 anuncios concurrentes. XML (5,2 s, un intento), después HTML (6 s) si el XML falla o no se valida. El HTML exige JSON-LD Legislation con el CVE exacto y texto. No usar menús, títulos solos o páginas de error como contenido.
3. Reintentar únicamente las descargas ausentes, dos rondas adicionales con pausas de 2 y 4 segundos.
4. `analyze`: lee hasta 24 textos de la caché. Reutiliza decisiones y procesa un lote nuevo por petición, hasta 12 anuncios y un objetivo estimado de 8.000 tokens de entrada, incluyendo los criterios. No es un recuento exacto del tokenizador; los anuncios grandes se procesan solos y nunca se recortan.
5. Un 503 prueba una vez el modelo alternativo. El modelo principal tiene 30 segundos de límite y el alternativo 20, dentro del presupuesto de una función de 60 segundos. En un timeout 504 se reduce el objetivo de 8.000 a 4.000 y luego 2.000 tokens estimados; el cliente reintenta los CVE pendientes en otra petición tras 15 segundos. Si un anuncio aislado sigue agotando el tiempo, se informa como pendiente y no se envía correo. Un 429 detiene la revisión y aplica una pausa compartida mínima de 60 segundos (o la indicada por Google si es mayor), sin cambiar de modelo ni subdividir lotes.
6. Las decisiones que faltan o no cumplen el esquema permanecen pendientes. El correo exige que todos los CVE del índice estén revisados.

## Reutilización

`@vercel/functions` Runtime Cache almacena textos válidos durante 24 horas y decisiones durante 7 días. Las decisiones dependen del contenido completo enviado, modelo efectivo, criterios, instrucciones y esquema. Cambiar alguno invalida la reutilización. El municipio es un filtro posterior y no provoca otra clasificación.

La caché es regional y temporal: puede expulsar entradas, no es un archivo permanente ni un bloqueo transaccional. Las búsquedas simultáneas en distintas instancias todavía pueden coincidir en alguna llamada; se deduplican las solicitudes idénticas dentro de una instancia. No se promete exactamente una llamada por anuncio. Al expirar un texto se vuelve a consultar el BOCM; una modificación durante sus 24 horas de vigencia requiere purgar la caché para verla inmediatamente.

No necesita Redis ni una nueva clave. En local el SDK usa memoria. En Vercel comprobar que no aparece `Runtime Cache unavailable` ni `bocmi_cache_unavailable`. Si la caché compartida no está disponible, no considerar validada la reutilización entre peticiones. La caché tiene consumo propio sujeto al plan de Vercel.

## Diagnóstico

- Web: contadores separados de descargados, revisados y análisis reutilizados; detalle de CVE pendientes al terminar una consulta parcial.
- Logs `bocm_download`: CVE y formato utilizado.
- Logs `bocmi_analysis`: decisiones reutilizadas, tamaño del lote, estimación de entrada, modelo y estado.
- Logs `gemini_usage`: uso que devuelve Google (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, etc.). No es un contador acumulado de facturación. Nunca registrar claves ni textos completos.
- Uso del proyecto: https://aistudio.google.com/usage
- Límites: https://aistudio.google.com/rate-limit
- Los 429 distinguen RPM/TPM/RPD cuando Google proporciona esos detalles; si no, se indica que el límite es desconocido. No atribuir todos los 429 al plan gratuito.

Opcional: `GEMINI_BATCH_TARGET_TOKENS` (por defecto 8000, rango 2000–16000). Ajustarlo tras observar el TPM real del proyecto. `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` y `GEMINI_API_KEY` conservan su función.

## Verificación

Ejecutar `node --test test/*.test.js`. Las pruebas simulan BOCM, Gemini y el correo, sin usar claves ni enviar mensajes. La búsqueda histórica conserva su interfaz y su lote único de análisis para no cambiar su cliente en esta revisión.

Después del despliegue, probar un mismo anuncio con `download` dos veces y comprobar `cacheHits`. Una búsqueda nueva muestra el trabajo real; la siguiente debería reutilizar las decisiones disponibles. Medir tiempos con la misma fecha y número de CVE. La disponibilidad del BOCM y la cuota de Gemini siguen siendo límites externos.
