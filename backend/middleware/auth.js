/**
 * middleware/auth.js
 * Usado solo dentro de api.js para proteger rutas especificas
 */

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'No autenticado' });
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Se requiere rol admin' });
}

module.exports = { requireAuth, requireAdmin };