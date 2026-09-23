// Quién ve qué proyecto. Admin: todos. Gestor: los que gestiona y a los que tiene acceso.
// Consultor: solo los proyectos a los que tiene acceso. El proyecto de tareas
// administrativas es visible para todos.

export function accessibleProjectIds(db, user) {
  if (user.role === 'admin') return null; // null = sin restricción
  return db.prepare(`
    SELECT id FROM projects WHERE is_internal = 1 OR pm_id = ?
    UNION SELECT project_id FROM project_members WHERE user_id = ?`).all(user.id, user.id).map((r) => r.id);
}

export function canSeeProject(db, user, projectId) {
  const ids = accessibleProjectIds(db, user);
  return ids === null || ids.includes(Number(projectId));
}

export function canManageProject(db, user, projectId) {
  if (user.role === 'admin') return true;
  if (user.role !== 'lider') return false;
  const p = db.prepare('SELECT pm_id, is_internal FROM projects WHERE id = ?').get(projectId);
  return !!p && !p.is_internal && p.pm_id === user.id;
}
