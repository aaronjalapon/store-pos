export function pesoInputToCentavos(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value || '0');
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function centavosToPesoInput(value: number) {
  return (value / 100).toFixed(2);
}
