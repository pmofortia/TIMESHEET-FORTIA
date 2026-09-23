# Timesheet Fortia

Sistema web para que los consultores de Fortia registren sus horas **por semana** contra las
tareas que tienen asignadas en **Microsoft Project**, con flujo de aprobación e indicadores de
**eficiencia** (horas facturables / disponibilidad), carga a proyectos y carga administrativa.

## Probar sin instalar nada (GitHub Codespaces)

1. En GitHub abre el repositorio y cambia a la rama `claude/fortia-hours-tracking-system-xu8ddo`.
2. Botón verde **Code › pestaña Codespaces › Create codespace on claude/fortia-hours-tracking-system-xu8ddo**.
3. Espera 2–3 minutos: instala, carga los datos demo y arranca solo. Se abre una pestaña con una
   URL tipo `https://<nombre>-3000.app.github.dev`. Si no se abre, ve a la pestaña **Ports** y abre el puerto 3000.
4. Entra con los usuarios demo (contraseña `Fortia2026!`).

La URL es privada (solo tu cuenta de GitHub) salvo que cambies la visibilidad del puerto a *Public*.
El codespace se apaga solo tras 30 min sin uso; los datos demo se regeneran al crearlo.

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
(o usa `ADMIN_EMAIL` / `ADMIN_PASSWORD`). Las variables se pueden poner en un archivo `.env`
(ver `.env.example`).

## Acceso con Microsoft 365

En producción se entra **solo con la cuenta de Microsoft 365 de Fortia** (`@fortia.com.mx`).
La app valida que el token venga del tenant de Fortia y que el correo sea del dominio permitido;
la contraseña local se apaga sola al configurar Microsoft. El primer acceso de un consultor lo da
de alta como *consultor* (configurable). Pasos para registrar la app en Entra ID, variables y reglas
de vinculación de cuentas: **[docs/microsoft-365.md](docs/microsoft-365.md)**.

Sin las variables `ENTRA_*`, el sistema funciona con usuario y contraseña locales (útil para el demo).

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `DB_FILE` | `data/timesheet.db` | Archivo SQLite |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Administrador inicial |
| `TARGET_EFFICIENCY` | `0.75` | Meta de eficiencia mostrada en los indicadores |
| `NODE_ENV=production` | — | Cookies de sesión `Secure` (requiere HTTPS) |
| `APP_BASE_URL`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | — | Activan el acceso con Microsoft 365 |
| `AUTH_ALLOWED_DOMAINS` | `fortia.com.mx` | Dominios de correo que pueden entrar |
| `AUTH_AUTO_PROVISION` | `true` | Alta automática como consultor en el primer acceso |
| `AUTH_LOCAL_ENABLED` | `false` con Microsoft, `true` sin él | Permite usuario/contraseña local |
| `TRUST_PROXY` | — | `true` si hay un proxy HTTPS delante (App Service, nginx) |

## Cómo funciona

1. **Administración (admin).** Catálogos que usa el resto del sistema:
   - *Tareas administrativas*: todo lo que no va a un proyecto. Cada una se marca si **descuenta
     disponibilidad** (por defecto: Vacaciones y permisos, Documentación IA, Innovación, Apoyo a Soporte,
     Capacitación). Si una tarea ya tiene horas, "eliminar" la desactiva para no perder historia.
   - *Días festivos* por año (vienen cargados los oficiales de 2026 en el demo).
   - *Clientes* (nombre y ejecutivo comercial): los proyectos solo pueden usar clientes de esta lista.
   - *Módulos vigentes* (AP, NOM, T&A, CH, GT, KIO, APP, R&S, CAP, EXP, COM, COMPULSA, EVD, PCS).
   - *Ajustes*: horas semanales por recurso (default **45 h**, lunes a viernes), con opción de aplicarlas a todos.
2. **Importación desde Project (gestor o admin).** Se sube el XML (*Archivo › Guardar como › XML*).
   Se leen tareas, WBS, fechas, trabajo planeado y asignaciones. **Todos los recursos se guardan**
   en el proyecto; cada uno se liga a un usuario por correo o nombre, y desde la ficha del proyecto se
   puede **reemplazar por cualquier usuario activo** (el reemplazo sobrevive a las reimportaciones).
   Quien cubre un recurso obtiene acceso al proyecto y sus tareas.
3. **Ficha del proyecto (gestor del proyecto o admin).** Nombre, código, cliente (catálogo), ejecutivo
   comercial, gestor (usuarios con rol *Gestor de proyecto*), estatus (Prerrequisitos, Por asignar,
   Asignado, Entregado, Activo, Estabilización, Gestionando pase a soporte, Suspendido), etapa
   (Preparación, Planificación y estimación, Implementación, Lanzamiento), horas vendidas, presupuesto
   USD y módulos. Cada tarea se clasifica con uno de los módulos del proyecto.
4. **Acceso.** Cada usuario solo ve los proyectos a los que tiene acceso (se administra en la ficha).
   El gestor ve los suyos y el admin todos. En proyectos *Entregados* o *Suspendidos* ya no se registran horas.
5. **Mi semana (consultor).** Semanas de **lunes a viernes**, con navegación a semanas anteriores y
   posteriores. Se precargan las tareas asignadas en Project para esas fechas; se pueden agregar otras
   tareas de proyectos con acceso o tareas administrativas. Horas a cubrir = horas semanales − festivos
   (p. ej. 45 − 9 = 36 h en la semana del 16 de septiembre).
6. **Aprobación.** El consultor envía; el gestor que aprueba sus horas (campo del usuario) aprueba,
   rechaza con motivo o reabre.

## Indicadores

| Indicador | Fórmula |
|---|---|
| Capacidad | `horas semanales / 5 × días hábiles (lun–vie) del periodo` |
| **Disponibilidad** | `capacidad − festivos − horas en tareas administrativas que descuentan disponibilidad` |
| Horas facturables / carga a proyectos | horas registradas en proyectos |
| Carga administrativa | horas en tareas administrativas (desglosadas por tarea) |
| **Eficiencia** | `horas facturables / disponibilidad`, en porcentaje |
| Horas sin registrar | `capacidad − festivos − horas registradas` |
| Vendido vs. real | horas reales acumuladas contra horas vendidas y planeadas en Project |
| Horas por módulo | horas de proyecto según el módulo de cada tarea |
| Cumplimiento | semanas cerradas con timesheet enviado o aprobado / semanas esperadas |

Solo cuentan timesheets enviados y aprobados (los borradores se incluyen con un filtro). Filtros por
periodo, consultor, cliente y proyecto. Los usuarios marcados como *no cuenta para disponibilidad*
(p. ej. el admin) no afectan los totales. Todo el detalle se exporta a CSV.

## Integración con Project: lo que hay y lo que falta

Hoy la integración es **por archivo** (XML de Project o CSV). La siguiente fase es conectarse a
**Project para la web / Planner Premium** vía Dataverse. Una sincronización automática depende
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
  oidc.js              inicio de sesión con Microsoft 365 (OIDC + PKCE)
  config.js            configuración de acceso desde variables de entorno
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

- **Conector a Planner Premium** (Dataverse) para dejar de subir el XML a mano.
- **Acceso de externos** como invitados B2B con un rol limitado (ver docs/microsoft-365.md).
- Recordatorio por correo o Teams cuando la semana no se envía.
- Respaldo del archivo SQLite, o migrar a PostgreSQL / Azure SQL si hay muchos usuarios concurrentes.
