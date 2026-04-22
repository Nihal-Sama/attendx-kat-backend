// ============================================================
//  requireRole.js — Role guard middleware factory
//  Usage: router.patch('/approve', requireRole('ceo'), controller)
//         router.get('/all',       requireRole('admin', 'ceo'), controller)
// ============================================================
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}.`,
      });
    }
    next();
  };
}

module.exports = requireRole;
