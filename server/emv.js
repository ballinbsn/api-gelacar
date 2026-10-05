// Lê o código Pix "copia e cola" (EMV/BR Code) e devolve os campos de nível 1.
export function parseEmv(code) {
  const out = {};
  let i = 0;
  const s = String(code || '');
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!Number.isInteger(len) || i + 4 + len > s.length) return null;
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

// Valor (em centavos) embutido no Pix, ou null se o código não trouxer valor / for inválido.
export function emvAmountCents(code) {
  const f = parseEmv(code);
  if (!f || !f['54']) return null;
  const v = Number(f['54']);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}
