import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDailyReport, formatReport, parseMailConfig, sendWithGmail } from '../lib/daily-report.js';

test('el informe incluye anuncios y enlaces oficiales; escapa el texto HTML', async () => {
  const requested = [];
  const fetcher = async url => {
    const params = new URL(url).searchParams;
    requested.push(params);
    if (params.get('mode') === 'manifest') return Response.json({
      found: true, bulletinNumber: 200, bulletinUrl: 'https://www.bocm.es/sumario',
      cves: ['BOCM-20261012-1', 'BOCM-20261012-2']
    });
    return Response.json({
      failedCves: [], results: [{ cve: 'BOCM-20261012-2', title: '<Plan especial>',
        summary: 'Aprobación inicial.', url: 'https://www.bocm.es/anuncio/2' }],
      complementary: [], doubtful: [], existingCount: 2
    });
  };
  const report = await collectDailyReport('https://consulta-ia-gemini-bocm.vercel.app/', '2026-10-12', fetcher);
  assert.equal(requested.length, 2);
  assert.equal(report.scanned, 2);
  assert.equal(report.principal.length, 1);
  const message = formatReport(report);
  assert.match(message.text, /https:\/\/www\.bocm\.es\/anuncio\/2/);
  assert.match(message.html, /&lt;Plan especial&gt;/);
  assert.doesNotMatch(message.html, /<Plan especial>/);
});

test('un XML pendiente impide tratar la consulta como completa y enviar el informe', async () => {
  const fetcher = async url => new URL(url).searchParams.get('mode') === 'manifest'
    ? Response.json({ found: true, cves: ['BOCM-20261012-1'] })
    : Response.json({ failedCves: ['BOCM-20261012-1'], results: [] });
  await assert.rejects(
    collectDailyReport('https://consulta-ia-gemini-bocm.vercel.app/', '2026-10-12', fetcher),
    /Consulta incompleta/
  );
});

test('un lote que agota el tiempo se divide y conserva todos los anuncios', async () => {
  const cves = Array.from({ length: 12 }, (_, index) => `BOCM-20261009-${index + 1}`);
  let largeRequests = 0;
  const fetcher = async url => {
    const params = new URL(url).searchParams;
    if (params.get('mode') === 'manifest') return Response.json({ found: true, cves, bulletinNumber: 200 });
    const batch = params.get('cves').split(',');
    if (batch.length > 6) {
      largeRequests++;
      return Response.json({ error: 'Tiempo agotado al consultar anuncios.' }, { status: 502 });
    }
    return Response.json({ failedCves: [], results: batch.map(cve => ({ cve, title: cve })) });
  };
  const report = await collectDailyReport('https://consulta-ia-gemini-bocm.vercel.app/', '2026-10-09', fetcher);
  assert.equal(largeRequests, 3);
  assert.equal(report.principal.length, 12);
  assert.equal(report.scanned, 12);
});

test('Gmail recibe el remitente autorizado y todos los destinatarios', async () => {
  const env = { BOCM_MAIL_FROM: 'bocmi@gmail.com', BOCM_MAIL_TO: 'uno@example.com, dos@example.com',
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh' };
  assert.deepEqual(parseMailConfig(env).to, ['uno@example.com', 'dos@example.com']);
  let sent = false;
  const fetcher = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'access' });
    assert.match(options.headers.Authorization, /^Bearer access$/);
    const mime = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString('utf8');
    assert.match(mime, /From: bocmi@gmail.com/);
    assert.match(mime, /To: uno@example.com, dos@example.com/);
    sent = true;
    return Response.json({ id: 'gmail-id' });
  };
  assert.equal(await sendWithGmail({ subject: 'Bocmi', text: 'Hola', html: '<p>Hola</p>' }, env, fetcher), 'gmail-id');
  assert.equal(sent, true);
});
