# Inicio de sesión con Microsoft 365

El sistema usa **OpenID Connect** contra Entra ID (antes Azure AD) de Fortia. Tiene dos candados:

1. **Tenant:** la app se registra como *single-tenant*. Solo se aceptan tokens emitidos por el
   tenant de Fortia (se verifica el claim `tid` y el emisor), así que una cuenta de otra
   organización no puede entrar aunque tenga un correo parecido.
2. **Dominio:** además, el correo de la cuenta debe terminar en `@fortia.com.mx`
   (`AUTH_ALLOWED_DOMAINS`). Esto deja fuera a los invitados B2B del tenant mientras no se habilite
   el acceso de externos.

La contraseña local se desactiva automáticamente en cuanto Microsoft está configurado.

## 1. Registrar la aplicación (lo hace un administrador de Entra ID)

1. Entra a <https://entra.microsoft.com> › **Identidad › Aplicaciones › Registros de aplicaciones › Nuevo registro**.
2. Nombre: `Timesheet Fortia`.
3. Tipos de cuenta: **Solo las cuentas de este directorio organizativo (solo Fortia: inquilino único)**.
4. URI de redirección: plataforma **Web**, valor `https://<dominio-del-sistema>/auth/microsoft/callback`
   (debe coincidir exactamente con `APP_BASE_URL` + `/auth/microsoft/callback`).
5. Después de crearla, copia de **Información general**:
   - *Id. de directorio (inquilino)* → `ENTRA_TENANT_ID`
   - *Id. de aplicación (cliente)* → `ENTRA_CLIENT_ID`
6. **Certificados y secretos › Nuevo secreto de cliente** → copia el *Valor* → `ENTRA_CLIENT_SECRET`.
   Anota la fecha de vencimiento: cuando caduque, nadie podrá entrar hasta renovarlo.
7. **Permisos de API:** con el permiso predeterminado `User.Read` (delegado) basta; se usan los
   scopes `openid profile email`. No se requiere consentimiento de administrador adicional.
8. *(Recomendado)* En **Aplicaciones empresariales › Timesheet Fortia › Propiedades**, activa
   **¿Se requiere asignación? = Sí** y asigna el grupo de consultores. Así solo ese grupo puede
   entrar, además del filtro de dominio.

## 2. Configurar el servidor

```bash
APP_BASE_URL=https://timesheet.fortia.com.mx
ENTRA_TENANT_ID=<guid del tenant>
ENTRA_CLIENT_ID=<guid de la app>
ENTRA_CLIENT_SECRET=<secreto>
ADMIN_EMAIL=eduardo.diaz@fortia.com.mx   # quien administra el sistema
NODE_ENV=production                       # cookies Secure; requiere HTTPS
TRUST_PROXY=true                          # si hay proxy o App Service delante
# Opcionales
AUTH_ALLOWED_DOMAINS=fortia.com.mx        # separados por coma
AUTH_AUTO_PROVISION=true                  # alta automática como consultor en el primer acceso
AUTH_LOCAL_ENABLED=false                  # true solo para una cuenta de emergencia
```

Al arrancar por primera vez se crea el administrador con `ADMIN_EMAIL`, que se liga a su cuenta
de Microsoft en su primer inicio de sesión.

## 3. Cómo se ligan las cuentas

| Situación | Resultado |
|---|---|
| Primer acceso y el admin ya dio de alta el correo | Se liga a ese usuario y conserva su rol, líder y capacidad |
| Primer acceso sin alta previa (`AUTH_AUTO_PROVISION=true`) | Se crea como **consultor** sin líder; el admin después le asigna líder y ajusta capacidad |
| Primer acceso sin alta previa (`AUTH_AUTO_PROVISION=false`) | Se rechaza: "pide acceso al administrador" |
| Accesos siguientes | Se identifica por el `oid` de Microsoft (no cambia aunque cambie el correo) |
| Cambió el correo en Microsoft | Se actualiza el correo en el sistema |
| Usuario desactivado en el sistema | Se rechaza aunque su cuenta de Microsoft siga activa |
| Cuenta recreada en Entra ID con el mismo correo | Se rechaza hasta que el admin marque *Desvincular cuenta de Microsoft 365* en el usuario |

Importante: el correo de cada consultor debe ser el mismo que el del recurso en Project para que
le aparezcan sus tareas.

## 4. Acceso de externos (siguiente fase)

La ruta recomendada es invitar a los externos como **usuarios invitados (B2B)** en el tenant de
Fortia. Así la autenticación sigue pasando por Entra ID (con MFA y revocación centralizada) y no
hay contraseñas propias que administrar. Lo que falta construir en el sistema:

- Agregar sus dominios a `AUTH_ALLOWED_DOMAINS`, o marcar a cada invitado de forma explícita.
- Un rol `externo` que solo vea los proyectos a los que está asignado, sin actividades internas de
  Fortia, sin indicadores del equipo y sin catálogo de proyectos.
- Aprobación de sus horas por el líder del proyecto (no por un jefe directo en Fortia).
