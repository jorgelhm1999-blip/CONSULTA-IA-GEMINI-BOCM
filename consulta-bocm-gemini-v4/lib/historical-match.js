// Coincidencias literales con equivalencia de tildes, espacios y guiones de
// final de línea. Los índices conservan la posición del texto original para
// mostrar un fragmento fiel y resaltar exactamente la expresión encontrada.
function folded(value, joinBrokenWords = false) {
  const source = String(value || '');
  let text = '';
  const starts = [];
  const ends = [];
  let index = 0;

  const append = (character, start, end) => {
    if (character === ' ' && (text.endsWith(' ') || !text)) return;
    text += character;
    starts.push(start);
    ends.push(end);
  };

  while (index < source.length) {
    const remaining = source.slice(index);
    const broken = remaining.match(/^[-‐‑–]\s+(?=\p{L})/u);
    if (broken && index > 0 && /\p{L}/u.test(source[index - 1])) {
      if (!joinBrokenWords) append(' ', index, index + broken[0].length);
      index += broken[0].length;
      continue;
    }
    const point = source.codePointAt(index);
    const original = String.fromCodePoint(point);
    const end = index + original.length;
    if (/\s/u.test(original)) append(' ', index, end);
    else {
      // La ñ es una letra distinta; las vocales acentuadas se equiparan.
      const lower = original.toLocaleLowerCase('es');
      const plain = lower === 'ñ' ? 'ñ' : lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      for (const character of plain) append(character, index, end);
    }
    index = end;
  }
  return { text: text.trimEnd(), starts, ends };
}

export function findLiteralMatch(source, query) {
  const needle = folded(query).text;
  if (!needle) return null;
  for (const joinBrokenWords of [false, true]) {
    const haystack = folded(source, joinBrokenWords);
    const position = haystack.text.indexOf(needle);
    if (position !== -1) {
      return {
        start: haystack.starts[position],
        end: haystack.ends[position + needle.length - 1]
      };
    }
  }
  return null;
}

export function matchingExcerpt(source, match) {
  const value = String(source || '');
  let start = Math.max(0, match.start - 88);
  let end = Math.min(value.length, match.end + 110);
  if (start && value[start - 1] !== ' ') {
    const next = value.indexOf(' ', start);
    if (next !== -1 && next < match.start) start = next + 1;
  }
  if (end < value.length && value[end] !== ' ') {
    const previous = value.lastIndexOf(' ', end);
    if (previous > match.end) end = previous;
  }
  const beginning = start ? '…' : '';
  const excerpt = `${beginning}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
  return {
    text: excerpt,
    highlightStart: beginning.length + match.start - start,
    highlightEnd: beginning.length + match.end - start
  };
}
