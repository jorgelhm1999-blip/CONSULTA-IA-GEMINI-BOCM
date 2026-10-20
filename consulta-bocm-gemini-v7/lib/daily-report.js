const BATCH_SIZE = 12;
const MAX_RETRY_ROUNDS = 3;
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const EMAIL_PATTERN = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export function madridDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = name => parts.find(item => item.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function validateDate(value) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : null;
  if (!date || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('BOCM_DATE debe ser una fecha válida AAAA-MM-DD.');
  }
  return value;
}

function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['bocm.es', 'www.bocm.es'].includes(url.hostname) ? url.href : '';
  } catch { return ''; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function sortCve(a, b) {
  return (Number(a.cve?.split('-').pop()) || 0) - (Number(b.cve?.split('-').pop()) || 0);
}

async function requestJson(baseUrl, params, fetcher) {
  const url = new URL('/api/search', baseUrl);
  url.search = new URLSearchParams(params).toString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetcher(url, { headers: { Accept: 'application/json' } });
    } catch (error) {
      if (attempt === 3) throw error;
    }
    if (response?.ok) return response.json();
    if (response && (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt === 3)) {
      const detail = await response.json().then(data => String(data?.error || '').slice(0, 250)).catch(() => '');
      throw new Error(`Bocmi devolvió HTTP ${response.status} al consultar ${params.mode}${detail ? `: ${detail}` : ''}.`);
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 1500));
  }
}

export async function collectDailyReport(baseUrl, date, fetcher = fetch) {
  validateDate(date);
  const manifest = await requestJson(baseUrl, { mode: 'manifest', date }, fetcher);
  if (!manifest.found) return { date, found: false, bulletinNumber: null, bulletinUrl: '', scanned: 0,
    total: 0, principal: [], complementary: [], doubtful: [] };
  if (!Array.isArray(manifest.cves) || !manifest.cves.length) throw new Error('El sumario no contiene anuncios comprobables.');

  const cves = [...new Set(manifest.cves)];
  const principal = new Map();
  const complementary = new Map();
  const doubtful = new Map();
  const failed = new Set(manifest.failedCves || []);

  async function processBatch(batch) {
    let data;
    try {
      data = await requestJson(baseUrl, { mode: 'batch', date, cves: batch.join(',') }, fetcher);
    } catch (error) {
      if (batch.length === 1 || !/HTTP (?:429|5\d\d)|fetch failed|timeout/i.test(String(error))) throw error;
      console.warn(`El lote de ${batch.length} anuncios falló. Se divide para reintentarlo.`);
      const middle = Math.ceil(batch.length / 2);
      await processBatch(batch.slice(0, middle));
      await processBatch(batch.slice(middle));
      return;
    }
    for (const item of data.results || []) principal.set(item.cve, item);
    for (const item of data.complementary || []) complementary.set(item.cve, item);
    for (const item of data.doubtful || []) doubtful.set(item.cve, item);
    const batchFailed = new Set(data.failedCves || []);
    for (const cve of batch) {
      if (batchFailed.has(cve)) failed.add(cve);
      else failed.delete(cve);
    }
  }

  for (let index = 0; index < cves.length; index += BATCH_SIZE) {
    await processBatch(cves.slice(index, index + BATCH_SIZE));
  }
  for (let round = 0; failed.size && round < MAX_RETRY_ROUNDS; round++) {
    const pending = [...failed];
    for (let index = 0; index < pending.length; index += BATCH_SIZE) {
      await processBatch(pending.slice(index, index + BATCH_SIZE));
    }
  }
  if (failed.size) throw new Error(`Consulta incompleta: ${failed.size} anuncios sin comprobar (${[...failed].join(', ')}). No se envía correo.`);

  return {
    date, found: true, bulletinNumber: manifest.bulletinNumber,
    bulletinUrl: officialUrl(manifest.bulletinUrl), scanned: cves.length, total: cves.length,
    principal: [...principal.values()].sort(sortCve),
    complementary: [...complementary.values()].sort(sortCve),
    doubtful: [...doubtful.values()].sort(sortCve)
  };
}

export function formatReport(report) {
  const prettyDate = report.date.split('-').reverse().join('/');
  const subject = `Bocmi · BOCM ${prettyDate}`;
  const sections = [
    ['Publicaciones de interés principal', report.principal],
    ['Avisos complementarios', report.complementary],
    ['Pendientes de revisión', report.doubtful]
  ];
  const count = sections.reduce((total, [, items]) => total + items.length, 0);
  const intro = report.found
    ? `Se adjuntan las noticias relevantes del BOCM del día ${prettyDate}. Se han revisado ${report.scanned} anuncios.`
    : `No se ha localizado un boletín BOCM para el día ${prettyDate}.`;
  const text = ['Buenos días:', '', intro, ''];
  const html = [`<p>Buenos días:</p><p>${escapeHtml(intro)}</p>`];
  if (report.found && !count) {
    text.push('No se han detectado publicaciones de interés.', '');
    html.push('<p>No se han detectado publicaciones de interés.</p>');
  }
  for (const [label, items] of sections) {
    if (!items.length) continue;
    text.push(label, '');
    html.push(`<h2>${escapeHtml(label)}</h2><ul>`);
    for (const item of items) {
      const url = officialUrl(item.url);
      text.push(`• ${item.title || item.cve || 'Anuncio BOCM'}`);
      if (item.summary) text.push(`  ${item.summary}`);
      if (url) text.push(`  ${url}`);
      text.push('');
      html.push(`<li><strong>${escapeHtml(item.title || item.cve || 'Anuncio BOCM')}</strong>`);
      if (item.summary) html.push(`<br>${escapeHtml(item.summary)}`);
      if (url) html.push(`<br><a href="${escapeHtml(url)}">Abrir anuncio oficial</a>`);
      html.push('</li>');
    }
    html.push('</ul>');
  }
  if (report.bulletinUrl) {
    text.push(`Sumario oficial: ${report.bulletinUrl}`);
    html.push(`<p><a href="${escapeHtml(report.bulletinUrl)}">Sumario oficial</a></p>`);
  }
  return { subject, text: text.join('\n').trim(), html: html.join('') };
}

export function parseMailConfig(env) {
  const from = String(env.BOCM_MAIL_FROM || '').trim();
  const to = String(env.BOCM_MAIL_TO || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!EMAIL_PATTERN.test(from) || !to.length || to.some(value => !EMAIL_PATTERN.test(value))) {
    throw new Error('Configura BOCM_MAIL_FROM y BOCM_MAIL_TO (direcciones separadas por comas).');
  }
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) {
    if (!env[name]) throw new Error(`Falta el secreto ${name}.`);
  }
  return { from, to };
}

function encodeBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export async function sendWithGmail(message, env, fetcher = fetch) {
  const { from, to } = parseMailConfig(env);
  const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token' }).toString()
  });
  if (!tokenResponse.ok) {
    // OAuth error codes are safe to log; never print tokens or credentials.
    const errorBody = await tokenResponse.json().catch(() => ({}));
    const code = typeof errorBody?.error === 'string' && /^[a-z_]+$/.test(errorBody.error)
      ? errorBody.error : '';
    const hint = code === 'invalid_grant'
      ? 'El refresh token ha caducado o fue revocado. Genera otro con las mismas credenciales OAuth y actualiza GOOGLE_REFRESH_TOKEN en GitHub Secrets.'
      : code === 'invalid_client'
        ? 'Comprueba que GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET pertenecen al mismo cliente OAuth que el refresh token.'
        : 'Revisa las credenciales OAuth en GitHub Secrets.';
    throw new Error(`Google no autorizó el envío (HTTP ${tokenResponse.status}${code ? `, ${code}` : ''}). ${hint}`);
  }
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error('Google no devolvió un token de acceso.');

  const boundary = `bocmi-${Date.now().toString(16)}`;
  const headers = [
    `From: ${from}`, `To: ${to.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  const mime = [
    ...headers, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', Buffer.from(message.text).toString('base64'),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', Buffer.from(message.html).toString('base64'),
    `--${boundary}--`, ''
  ].join('\r\n');
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encodeBase64Url(mime) })
  });
  if (!response.ok) throw new Error(`Gmail no pudo enviar el informe (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data.id) throw new Error('Gmail no confirmó el identificador del mensaje enviado.');
  return data.id;
}
