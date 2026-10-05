import { VEHICLE_CATEGORIES } from './catalog.js';

const SIDE_LABEL = { front: 'Frente', rear: 'Traseira' };

const clean = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Normaliza uma unidade personalizada (objeto estruturado enviado pelo navegador).
function normalizeUnit(u) {
  if (!u || typeof u !== 'object') return null;
  const view = u.view === 'front' || u.view === 'rear' ? u.view : null;
  const out = {
    side: view ? SIDE_LABEL[view] : null,
    view,
    category: clean(u.category, 40) || null,
    category_label: VEHICLE_CATEGORIES[u.category] || null,
    brand: clean(u.brand),
    model: clean(u.model),
    year: clean(u.year, 4),
    color: clean(u.color, 40),
    plate_name: clean(u.plateName ?? u.plate_name, 60),
    manual: !!u.manual,
  };
  return out;
}

// Texto "Unidade N: Marca Modelo Ano • Cor • Frente • Placa: NOME" (gerado pela página) → campos,
// usado só como reserva quando o navegador não enviou o objeto estruturado.
export function parseUnitText(text) {
  const m = /^(?:Un(?:idade|\.)\s*\d+:\s*)?(.+?)\s*•\s*([^•]+?)\s*•\s*(Frente|Traseira)\s*•\s*Placa:\s*(.+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const head = m[1];
  const ym = /^(.*?)\s+(\d{4})$/.exec(head);
  return {
    side: m[3],
    view: m[3] === 'Frente' ? 'front' : 'rear',
    category: null,
    category_label: null,
    brand_model_text: clean(ym ? ym[1] : head, 200),
    brand: '',
    model: '',
    year: ym ? ym[2] : '',
    color: clean(m[2], 40),
    plate_name: clean(m[4], 60),
    manual: false,
    parsed_from_text: true,
  };
}

export function unitIsComplete(u) {
  if (!u) return false;
  const hasVehicle = (u.brand && u.model) || u.brand_model_text;
  return !!(u.side && hasVehicle && /^\d{4}$/.test(u.year) && u.color && u.plate_name);
}

// Monta a lista final de unidades do pedido, na ordem, com numeração contínua.
// `lines` vem de priceOrder; `items` é o payload do navegador.
export function buildUnits(items, lines) {
  const units = [];
  const warnings = [];
  items.forEach((item, idx) => {
    const line = lines[idx];
    const expected = line.units;
    let structured = Array.isArray(item.personalization) ? item.personalization.map(normalizeUnit).filter(Boolean) : [];
    if (structured.length === 0) {
      const texts = Array.isArray(item.units) && item.units.length ? item.units : item.variant ? String(item.variant).split(' | ') : [];
      structured = texts.map(parseUnitText).filter(Boolean);
      if (structured.length) warnings.push(`item ${idx + 1}: personalização reconstruída a partir do texto`);
    }
    if (structured.length !== expected) warnings.push(`item ${idx + 1}: esperadas ${expected} unidade(s) personalizada(s), recebidas ${structured.length}`);
    for (let i = 0; i < Math.max(expected, structured.length); i++) {
      const u = structured[i] || null;
      units.push({
        n: units.length + 1,
        product_id: line.product.id,
        product_slug: line.product.slug,
        product_name: line.product.name,
        ...(u || { side: null, brand: '', model: '', year: '', color: '', plate_name: '' }),
        complete: unitIsComplete(u),
      });
    }
  });
  const complete = units.length > 0 && units.every((u) => u.complete) && warnings.length === 0;
  return { units, warnings, complete };
}

export function describeUnit(u) {
  const vehicle = u.brand_model_text || `${u.brand} ${u.model}`.trim();
  return `Unidade ${u.n}: ${vehicle} ${u.year} • ${u.color} • ${u.side} • Placa: ${u.plate_name}`;
}
