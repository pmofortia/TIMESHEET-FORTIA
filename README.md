# Timesheet Fortia

Sistema web para que los consultores de Fortia registren sus horas **por semana** contra las
tareas que tienen asignadas en **Microsoft Project**, con flujo de aprobación e indicadores de
**cargabilidad** y distribución de horas por rubro.

## Arranque rápido

Requiere Node.js 22.13 o superior (usa el SQLite integrado de Node; no hay dependencias nativas).

```bash
npm install
npm run seed      # datos de demostración (opcional)
npm start         # http://localhost:3000
npm test
```

Usuarios del demo (contraseña `Fortia2026!`): `admin@fortia.com.mx`, `laura.martinez@fortia.com.mx`
(líder), `ana.lopez@fortia.com.mx`, `carlos.ramirez@fortia.com.mx`, `maria.hernandez@fortia.com.mx`.

Sin `seed`, el primer arranque crea un administrador y muestra la contraseña en consola
(o usa `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `DB_FILE` | `data/timesheet.db` | Archivo SQLite |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Administrador inicial |
| `TARGET_UTILIZATION` | `0.75` | Meta de cargabilidad mostrada en los indicadores |
| `NODE_ENV=production` | — | Cookies de sesión `Secure` (requiere HTTPS) |

## Cómo funciona

1. **El plan se importa desde Project.** Un líder o admin sube el XML del proyecto
   (*Archivo › Guardar como › Formato XML*). Se leen tareas, jerarquía (WBS), fechas, trabajo
   planeado y asignaciones. Los recursos de Project se vinculan con los usuarios **por correo
   electrónico** (campo *Correo electrónico* del recurso) o, si no lo tiene, por nombre.
   Siempre hay **vista previa** antes de escribir, y reimportar es seguro: actualiza tareas,
   reemplaza asignaciones y desactiva (no borra) las tareas que ya no vienen en el archivo.
   También se acepta CSV (exportado de Excel) para planes que no viven en Project.
2. **El consultor captura su semana.** La pantalla *Mi semana* precarga las tareas que Project le
   asigna con fechas dentro de esa semana. Puede agregar otras tareas suyas o actividades internas
   abiertas a todos (preventa, capacitación, juntas, administrativo, vacaciones, permisos, festivos).
   No puede cargar horas a tareas que no le asignaron. Validaciones: máx. 24 h por día, cuartos de hora.
3. **Envío y aprobación.** El consultor envía; su líder directo (campo *Líder* del usuario) aprueba,
   rechaza con motivo o reabre. Un timesheet enviado o aprobado queda bloqueado.
4. **Indicadores.** Solo cuentan timesheets enviados y aprobados (los borradores se pueden incluir
   con un filtro). Consultor ve lo suyo, líder ve a su equipo, admin ve todo.

## Indicadores

| Indicador | Fórmula |
|---|---|
| Capacidad | `capacidad semanal / 5 × días hábiles del periodo` (lun–vie) |
| **Cargabilidad** | `horas facturables / capacidad` |
| **Cargabilidad neta** | `horas facturables / (capacidad − horas de ausencia)` |
| Ocupación | `horas totales registradas / capacidad` |
| Horas por rubro | facturable, preventa, interno, capacitación, administrativo, ausencia |
| Plan vs. real | horas reales acumuladas vs. trabajo planeado en Project, por proyecto y tarea |
| Cumplimiento | semanas cerradas con timesheet enviado o aprobado / semanas esperadas |

El rubro de una hora es el de su tarea (si se definió) o el de su proyecto. Los usuarios marcados
como *no cuenta para cargabilidad* (p. ej. el admin) no afectan capacidad ni cargabilidad.
Todo el detalle se exporta a CSV (compatible con Excel/Power BI).

## Integración con Project: lo que hay y lo que falta

Hoy la integración es **por archivo** (XML de Project o CSV). Una sincronización automática depende
de qué producto usa Fortia, porque cada uno tiene una API distinta:

| Producto | Vía de integración automática |
|---|---|
| Project de escritorio (.mpp en SharePoint/OneDrive) | No tiene API; se mantiene la importación por XML |
| Project Online / Project Server (PWA) | OData `/_api/ProjectData` (Projects, Tasks, Assignments, Resources) con app de Entra ID |
| Project para la web / Planner Premium | Dataverse Web API (tablas `msdyn_project`, `msdyn_projecttask`, `msdyn_resourceassignment`) |

El importador ya está separado del parser (`src/services/plans.js › applyPlan` recibe un plan
normalizado), así que un conector automático solo tiene que producir ese mismo objeto y ejecutarse
de forma programada.

## Estructura

```
src/
  app.js               API REST (Express) y archivos estáticos
  db.js                esquema SQLite y rubros
  auth.js              contraseñas scrypt, sesiones, permisos por rol
  importers/mspdi.js   lector del XML de Microsoft Project
  importers/csv.js     lector CSV (coma o punto y coma, fechas dd/mm/aaaa)
  services/plans.js    aplica un plan importado (idempotente)
  services/timesheets.js  captura, envío y aprobación
  services/metrics.js  indicadores y exportación
public/                SPA en JavaScript sin paso de build
samples/               XML y CSV de ejemplo
test/                  pruebas (node --test)
```

## Pendientes recomendados antes de producción

- **Inicio de sesión con Microsoft 365 (Entra ID)** en lugar de contraseñas locales.
- **Calendario de días festivos** para que la capacidad no los cuente como hábiles.
- **Conector automático** a Project Online o Dataverse (ver tabla de integración).
- Recordatorio por correo o Teams cuando la semana no se envía.
- Respaldo del archivo SQLite, o migrar a PostgreSQL / Azure SQL si hay muchos usuarios concurrentes.
