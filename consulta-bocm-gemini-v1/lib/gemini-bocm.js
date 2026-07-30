import { CRITERIOS_BOCM } from './criterios-bocm.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resultados: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cve: { type: 'string' },
          decision: { type: 'string', enum: ['incluir', 'excluir', 'revisar'] },
          categoria: { type: 'string' },
          motivo: { type: 'string' },
          municipio: { type: 'string' }
        },
        required: ['cve', 'decision', 'categoria', 'motivo', 'municipio']
      }
    }
  },
  required: ['resultados']
};

function outputText(response) {
  const parts = [];
  for (const candidate of response?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

function friendlyGeminiError(status, data) {
  const message = data?.error?.message || '';
  if (status === 429) {
    return 'Se ha alcanzado temporalmente el límite gratuito de Gemini. Espera un poco y vuelve a intentarlo.';
  }
  if (status === 400 && /api key/i.test(message)) {
    return 'La clave de Gemini no es válida o no está autorizada para esta API.';
  }
  if (status === 403) {
    return 'Gemini ha rechazado la petición. Revisa la clave, el proyecto y que la API esté habilitada.';
  }
  return message || `La revisión de Gemini falló (${status}).`;
}

async function callGemini(input, stage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en Vercel.');

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `${CRITERIOS_BOCM}\n\nETAPA ACTUAL: ${stage}` }]
        },
        contents: [{
          role: 'user',
          parts: [{ text: JSON.stringify(input) }]
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseJsonSchema: resultSchema
        }
      })
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Gemini devolvió una respuesta no válida (${response.status}).`);
    }

    if (!response.ok) throw new Error(friendlyGeminiError(response.status, data));

    const text = outputText(data);
    if (!text) throw new Error('Gemini no devolvió la clasificación esperada.');

    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Gemini devolvió una clasificación que no pudo interpretarse como JSON.');
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Gemini tardó demasiado en responder. Vuelve a intentarlo.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function compactRecord(record, includeBody = false) {
  const base = {
    cve: record.cve,
    seccion: record.section || '',
    departamento: record.department || '',
    organismo: record.organization || '',
    titulo: record.title || ''
  };
  if (includeBody) base.texto = String(record.body || '').slice(0, 12000);
  return base;
}

export async function analyzeBocmRecords(records) {
  if (!records.length) return [];

  const first = await callGemini(
    { anuncios: records.map(record => compactRecord(record, false)) },
    'Primera revisión con metadatos y título. Devuelve una decisión para todos los CVE recibidos.'
  );
  const firstMap = new Map((first.resultados || []).map(item => [item.cve, item]));

  const uncertain = records.filter(record => firstMap.get(record.cve)?.decision === 'revisar');
  if (uncertain.length) {
    const second = await callGemini(
      { anuncios: uncertain.map(record => compactRecord(record, true)) },
      'Segunda revisión con el texto completo. Resuelve como incluir o excluir siempre que sea razonable.'
    );
    for (const item of second.resultados || []) firstMap.set(item.cve, item);
  }

  return records.map(record => firstMap.get(record.cve) || ({
    cve: record.cve,
    decision: 'revisar',
    categoria: 'Sin clasificar',
    motivo: 'Gemini no devolvió una decisión para este anuncio.',
    municipio: ''
  }));
}
