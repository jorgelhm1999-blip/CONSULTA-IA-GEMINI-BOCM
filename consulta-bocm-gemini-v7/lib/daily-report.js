import { collectBulletin } from './query-client.js';
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

export async function collectDailyReport(baseUrl, date, fetcher = fetch) {
  validateDate(date);
  const report = await collectBulletin(baseUrl, date, { fetcher, onProgress: progress => {
    console.log(`BOCM ${progress.phase}: ${progress.downloaded}/${progress.total} descargados, ${progress.scanned} revisados; ${progress.aiCacheHits} análisis reutilizados.`);
  } });
  if (report.failedCves.length) throw new Error(`Consulta incompleta: ${report.failedCves.length} anuncios sin comprobar (${report.failedCves.join(', ')}). No se envía correo.`);
  report.bulletinUrl = officialUrl(report.bulletinUrl);
  return report;
}

// A failed complete pass may still have cached many valid source texts and AI
// decisions. Retry the report itself so nobody has to warm the web UI by hand.
export async function collectDailyReportWithRetry(baseUrl, date, {
  collect = collectDailyReport, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 3
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await collect(baseUrl, date);
    } catch (error) {
      const transient = error.status === 504 || error.status === 502 || error.status === 503
        || /Consulta incompleta|Gemini tardó demasiado|HTTP 50[0234]|fetch failed|timeout/i.test(error.message || '');
      if (!transient || attempt === maxAttempts) throw error;
      const pauseMs = attempt * 60000;
      console.warn(`Informe incompleto (intento ${attempt}/${maxAttempts}): ${error.message}. Reintentando automáticamente en ${pauseMs / 1000} s; se conserva lo validado.`);
      await wait(pauseMs);
    }
  }
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

export function parseMailConfig(env, { requireOAuth = true } = {}) {
  const from = String(env.BOCM_MAIL_FROM || '').trim();
  const to = String(env.BOCM_MAIL_TO || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!EMAIL_PATTERN.test(from) || !to.length || to.some(value => !EMAIL_PATTERN.test(value))) {
    throw new Error('Configura BOCM_MAIL_FROM y BOCM_MAIL_TO (direcciones separadas por comas).');
  }
  if (requireOAuth) {
    for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) {
      if (!env[name]) throw new Error(`Falta el secreto ${name}.`);
    }
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

