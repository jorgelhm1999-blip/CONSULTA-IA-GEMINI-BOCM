# Consulta Diaria BOCM con Gemini v3

Versión centrada en planeamiento urbanístico, proyectos de urbanización,
tramitación ambiental urbanística y actuaciones de especial incidencia
territorial.

## Novedades

- Criterio mucho más restrictivo: no es un buscador general de ingeniería civil.
- Exclusión expresa de empleo, estacionamiento regulado, mantenimiento de
  caminos rurales y grandes contratos de obra sin tramitación urbanística.
- Tratamiento específico de actuaciones de Canal de Isabel II ligadas a
  desarrollos urbanísticos.
- Resumen generado desde el texto completo de cada anuncio seleccionado.
- Reintentos automáticos ante saturación temporal de Gemini.

## Variables de Vercel

- `GEMINI_API_KEY`: clave privada de Gemini.
- `GEMINI_MODEL`: modelo disponible en el proyecto de Google AI Studio.
