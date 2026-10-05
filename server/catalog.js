import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Gerado por tools/build-public.mjs a partir do espelho público do site de referência.
export const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'catalog.json'), 'utf8'));

export const PRODUCTS = [catalog.product];

export function findProduct({ id, slug }) {
  return PRODUCTS.find((p) => (id && p.id === id) || (slug && p.slug === slug)) || null;
}

export const VEHICLE_CATEGORIES = {
  pickup: 'Picape',
  suv: 'SUV',
  sedan: 'Sedã',
  hatch: 'Hatch',
  sports_coupe: 'Esportivo / Coupé',
  convertible: 'Conversível',
};
