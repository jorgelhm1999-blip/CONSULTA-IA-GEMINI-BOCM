# Consulta Diaria BOCM · versión 7 preparada

La versión 7 añade el informe diario por correo. Es una propuesta basada en la copia
de la versión 6 del 29/09/2026: antes de subirla se debe comparar con la rama
actual conectada a Vercel. No hay correo configurado ni envío activado en esta copia.

Aplicación web con dos modos independientes:

- **Consulta diaria:** obtiene los CVE de los enlaces individuales del sumario oficial y consulta sus XML; Gemini clasifica los anuncios en dos etapas y resume los seleccionados.
- **Búsqueda histórica:** busca una palabra, un municipio o ambos en un intervalo de hasta 366 días. El interruptor «Aplicar criterios de interés» está encendido por defecto. Gemini revisa únicamente las coincidencias con los mismos criterios de la consulta diaria y muestra las de interés principal o complementario.
- **Informe diario automático:** GitHub Actions consulta los mismos endpoints diarios por lotes y envía el informe con Gmail. No necesita dejar abierta la web.

## Informe diario v7

El archivo `.github/workflows/informe-diario.yml` en la raíz del repositorio
ejecuta `consulta-bocm-gemini-v7/scripts/daily-report.js`
cada día a las 08:30 en `Europe/Madrid`, incluidos los cambios de horario.
La programación y el botón manual de GitHub Actions funcionan sobre la rama
predeterminada. Para cambiar la hora, edita `cron: '30 8 * * *'` en el flujo de la raíz: el primer
número son los minutos y el segundo la hora local, en formato de 24 horas.

El proceso pide el manifiesto a `/api/search?mode=manifest`, consulta lotes de
12 anuncios por `/api/search?mode=batch`, reintenta hasta tres veces los XML
pendientes, y usa los resultados principales, complementarios y dudosos que
ya clasifica Bocmi. Si la consulta queda incompleta, **no envía un informe
engañosamente completo**: el trabajo falla y queda visible en GitHub Actions.
Si el día no tiene BOCM, el mensaje lo indica. Si existe boletín pero no hay
anuncios relevantes, el correo confirma la revisión y su recuento. El mensaje
lleva resumen y enlace al anuncio oficial; solo se incluyen enlaces HTTPS de
`bocm.es`. No adjunta PDF.

El flujo manual (`Run workflow`) permite indicar una fecha y probar con
`dry_run=true`, que muestra una vista previa sin enviar. La ejecución programada
sí envía cuando las credenciales están configuradas. Después del envío crea un
artefacto de GitHub por fecha y comprueba ese registro antes de una repetición.
La concurrencia impide dos ejecuciones simultáneas. Sigue habiendo una pequeña
ventana de duplicación si Gmail acepta el mensaje y falla el registro posterior;
en ese caso se debe comprobar «Enviados» antes de repetir manualmente.

### Configuración de GitHub

En el repositorio que usa Vercel, abre **Settings → Secrets and variables →
Actions**. En **Variables** crea `BOCM_APP_URL` con
`https://consulta-ia-gemini-bocm.vercel.app/`. En **Repository secrets** crea:

| Nombre | Contenido |
| --- | --- |
| `BOCM_MAIL_FROM` | Dirección Gmail dedicada desde la que saldrán los mensajes. |
| `BOCM_MAIL_TO` | Destinatarios separados por comas, por ejemplo `persona1@ejemplo.es,persona2@ejemplo.es`. |
| `GOOGLE_CLIENT_ID` | Identificador del cliente OAuth creado en Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | Secreto del cliente OAuth. |
| `GOOGLE_REFRESH_TOKEN` | Autorización persistente de esa cuenta Gmail con permiso `gmail.send`. |

Es la cuenta que concede la autorización OAuth la que envía realmente el
mensaje. `BOCM_MAIL_FROM` debe ser esa misma cuenta o un alias de envío
autorizado en Gmail. Los destinatarios ven ese remitente y pueden responderle.
No pongas credenciales en el código, en el ZIP ni en un mensaje de chat.
La cuenta Gmail dedicada evita verificar el dominio corporativo para este
envío; el correo tendrá dirección `@gmail.com`, salvo que se configure un
remitente corporativo con las autorizaciones oportunas.

Para obtener una autorización OAuth hay que crear un proyecto de Google Cloud,
habilitar Gmail API, configurar la pantalla de consentimiento, pedir el permiso
`https://www.googleapis.com/auth/gmail.send` y autorizar la cuenta remitente.
Una vía sin instalar Node en el equipo es crear un cliente OAuth de tipo
**Aplicación web**, añadir la URL de redirección
`https://developers.google.com/oauthplayground` y usar el OAuth Playground
oficial con **Use your own OAuth credentials**. Se autoriza únicamente la cuenta
remitente y el alcance `gmail.send`; después se obtienen client ID, client
secret y refresh token para guardarlos directamente como secrets de GitHub.
No uses las credenciales propias del Playground: sus refresh tokens caducan a
las 24 horas. Si el proyecto OAuth externo queda en estado **Testing**, Google
limita a siete días la validez del refresh token con este alcance. Revisar el
estado de publicación antes de activar el envío estable.

La configuración de OAuth y la prueba de envío se harán con la persona que
controle esa cuenta; esta entrega **no contiene tokens**. Google puede exigir
pasos adicionales según el tipo y el estado de publicación de la aplicación.

En Vercel **permanece** `GEMINI_API_KEY` en **Settings → Environment Variables**.
Es un secreto distinto: Vercel usa Gemini para clasificar los anuncios; GitHub
solo solicita el resultado a la API existente de Bocmi. Los secretos de Actions
se entregan como variables de entorno al proceso del informe y GitHub oculta
sus valores tras guardarlos. Una persona con permiso para modificar el flujo
del repositorio podría usarlos; protege los permisos de escritura del repositorio.

Antes de activar el envío: comparar esta v7 con el GitHub actualmente desplegado,
probar `dry_run`, ejecutar un envío manual a una dirección de prueba, revisar
el correo recibido y después añadir los destinatarios definitivos. En la VM
corporativa no hace falta instalar Node: el proceso corre en GitHub.

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

1. En este repositorio la versión 7 se encuentra en `consulta-bocm-gemini-v7`. Si decides desplegar esta carpeta desde Vercel, configura **Root Directory** como `consulta-bocm-gemini-v7`. Confirma antes qué carpeta utiliza actualmente el despliegue; el informe automático consulta la URL pública indicada en `BOCM_APP_URL`.
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
