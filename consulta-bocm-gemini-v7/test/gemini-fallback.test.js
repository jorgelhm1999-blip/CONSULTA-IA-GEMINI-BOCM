import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBocmRecords } from '../lib/gemini-bocm.js';

test('una respuesta 503 activa el modelo alternativo con el mismo esquema y criterios', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.GEMINI_API_KEY = 'clave-de-prueba';
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).includes('gemini-3.1-flash-lite')) {
        return Response.json({ error: { message: 'High demand' } }, { status: 503 });
      }
      const result = { resultados: [{ cve: 'BOCM-20261021-1', decision: 'principal',
        categoria: 'Urbanismo', objeto_real: 'Plan especial', relacion_directa: true,
        motivo: 'Aprobación', municipio: 'Madrid', resumen: 'Plan especial.' }] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });
    };
    const records = [{ cve: 'BOCM-20261021-1', title: 'Plan especial' }];
    const result = await analyzeBocmRecords(records);
    assert.equal(result[0].decision, 'principal');
    assert.deepEqual(calls.map(call => new URL(call.url).pathname.split('/').pop()), [
      'gemini-3.1-flash-lite:generateContent', 'gemini-3.5-flash-lite:generateContent'
    ]);
    assert.deepEqual(calls[0].body, calls[1].body);
    await analyzeBocmRecords(records);
    assert.equal(calls.length, 2, 'la siguiente consulta reutiliza la decisión del modelo alternativo');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

