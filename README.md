# Urban SHOP

Tienda de perfumes árabes masculinos con catálogo, precios y stock administrables. Los pedidos se arman en la web y se envían a WhatsApp para confirmar disponibilidad y coordinar una transferencia. No procesa pagos ni descuenta stock automáticamente.

## Requisitos

- Node.js 20.6 o posterior.
- Una base PostgreSQL accesible desde el hosting (por ejemplo, un proyecto Supabase).

La app crea las tablas necesarias al iniciar; el catálogo comienza vacío.

## Crear una base gratuita con Supabase

1. Creá una cuenta y un proyecto nuevo en [Supabase](https://supabase.com/). Elegí una contraseña para la base y guardala en un lugar seguro: no es la misma que la contraseña del panel de Urban SHOP.
2. Esperá que el proyecto termine de crearse. En el Dashboard, abrí **Connect** y elegí **Session pooler** para copiar la URL de PostgreSQL. En la URL, reemplazá `[YOUR-PASSWORD]` por la contraseña de base de datos. No publiques ni envíes esta URL; contiene una credencial privada.
3. En PowerShell, dentro de esta carpeta, creá el archivo local de configuración:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

4. En `.env`, pegá la URL en `DATABASE_URL` y definí `ADMIN_USERNAME` y una contraseña única de al menos 12 caracteres para `ADMIN_PASSWORD`. Si Node muestra `self-signed certificate in certificate chain`, descargá la CA oficial desde Supabase **Database → Settings → SSL Configuration**, guardala en una ubicación local y pegá la ruta completa en `PGSSLROOTCERT` (por ejemplo, `C:\Users\Diego\Downloads\prod-ca-2021.crt`). La verificación del certificado permanece habilitada; no uses `NODE_TLS_REJECT_UNAUTHORIZED=0`. Generá un secreto aleatorio para `SESSION_SECRET` con:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   Copiá el resultado en `SESSION_SECRET`. No compartas el archivo `.env`; ya está excluido de Git.

## Iniciar en Windows

Después de instalar Node.js, cerrá y volvé a abrir VS Code para que su terminal actualice el `PATH`. Comprobá `node --version` y `npm --version`. Si Node aún no se reconoce, usá temporalmente la ruta completa:

```powershell
& 'C:\Program Files\nodejs\node.exe' --version
& 'C:\Program Files\nodejs\npm.cmd' install
& 'C:\Program Files\nodejs\npm.cmd' start
```

Como alternativa, ejecutá `.\setup.ps1` desde PowerShell dentro de esta carpeta: crea `.env` si falta, lo abre para completar la primera vez, instala dependencias y arranca el servidor. No compartas el archivo `.env`.

O iniciá el servidor manualmente desde esta carpeta:

```powershell
npm install
npm start
```

Abrí <http://localhost:4173>. El panel privado está en <http://localhost:4173/admin>. Al iniciar, la aplicación crea las tablas en PostgreSQL; el catálogo queda vacío hasta que agregues perfumes desde el panel.

## Publicación con GitHub y Render

El proyecto incluye `render.yaml` para crear el servicio web de Urban SHOP en Render. El plan configurado es gratuito; puede suspenderse cuando no recibe tráfico y tardar en responder al primer acceso. Revisá las condiciones vigentes de Render antes de publicar.

1. Creá un repositorio **privado** en GitHub para este proyecto.
2. Inicializá Git en la carpeta `perfumeria`, guardá los archivos del proyecto y subilos al repositorio. No incluyas `.env`, otros archivos `.env.*`, certificados ni `node_modules`; `.gitignore` los excluye.
3. En Render, elegí **New → Blueprint**, conectá el repositorio y aplicá la configuración de `render.yaml`.
4. Cargá en Render estas variables privadas cuando te las solicite:
   - `DATABASE_URL`: URL de PostgreSQL de Supabase. Usá **Connect → Session pooler** y no la publiques.
   - `ADMIN_USERNAME`: usuario para `/admin`.
   - `ADMIN_PASSWORD`: contraseña única de al menos 12 caracteres.
   - `SESSION_SECRET`: secreto aleatorio. Podés generarlo localmente con `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`. No uses un generador de contraseñas compartido ni pegues el secreto en GitHub.
   - `NODE_ENV` ya se define como `production` en `render.yaml`; Render proporciona `PORT` automáticamente.
5. Esperá que el despliegue termine y abrí la URL que Render asigna. El estado se comprueba en `/healthz`; la tienda está en `/` y el panel privado en `/admin`.

Si el servidor informa un error de certificado SSL al conectar con Supabase, descargá la CA oficial y agregala en Render como **Secret File** (por ejemplo, `prod-ca-2021.crt`). Definí `PGSSLROOTCERT` con `/etc/secrets/prod-ca-2021.crt` y volvé a desplegar. No desactives la validación del certificado.

La app crea las tablas de PostgreSQL al arrancar. Después de publicar, iniciá sesión en el panel para cargar perfumes y configurá allí WhatsApp y los datos de transferencia. El servidor escucha en `0.0.0.0` y usa el puerto `PORT` de Render. Nunca subas `.env` ni configures credenciales directamente en el código.

## Uso del panel

- En `/admin`, iniciá sesión con el usuario y la contraseña definidos en el hosting.
- Agregá perfumes y editá marca, tamaño, descripción, precio, stock, foto por URL y visibilidad.
- Los productos con stock cero aparecen como agotados y no se pueden agregar al carrito. Si se desactiva «Mostrar en la tienda», no se muestran.
- Configurá WhatsApp con código de país, alias y titular desde el panel cuando los tengas.
- El pedido se manda como mensaje para confirmar. Revisá stock y pago antes de confirmar: el carrito no reserva ni descuenta unidades.

Las sesiones de administrador son temporales y se invalidan cuando se reinicia el servidor. Usá HTTPS y una contraseña fuerte. No se guardan datos de pago ni tarjetas.
