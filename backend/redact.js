/**
 * redact.js — enmascarado de datos personales para logs.
 * Los logs de Railway se guardan en EE. UU. y no se pueden borrar por entrada: nunca deben llevar
 * teléfonos completos ni contenido de mensajes (RGPD, minimización).
 */
function maskPhone(v) {
  const d = String(v ?? '').split('@')[0].replace(/\D/g, '');
  if (!d) return '—';
  if (d.length <= 6) return '*'.repeat(d.length);
  return `${d.slice(0, 3)}${'*'.repeat(d.length - 5)}${d.slice(-2)}`;
}
module.exports = { maskPhone };
