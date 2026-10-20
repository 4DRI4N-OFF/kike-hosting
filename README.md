# Kike Hosting

Panel local para alojar servidores de **Minecraft Java** en Windows. Diseño claro estilo Apple (con modo oscuro): todo se maneja desde ventanas en el navegador — consola en vivo, ajustes, versiones, plugins y copias — protegido con un PIN que creas tú la primera vez.

## Empieza aquí

1. En GitHub, pulsa **Code → Download ZIP**. Extrae toda la carpeta en una ubicación tuya, por ejemplo `Documentos\KikeHosting`. No lo ejecutes dentro del ZIP.
2. Haz doble clic en **Iniciar.cmd**. El script comprueba Node.js 20+ y Java 21+. Si falta alguno, ofrece instalarlo con winget, pero solo si respondes `s`. Windows puede pedir permiso de administrador.
3. Si winget no está disponible, instala [Node.js LTS](https://nodejs.org/) y [Eclipse Temurin](https://adoptium.net/temurin/releases/) y vuelve a abrir el script. Recomendado: **Java 25** para versiones recientes. Java 21 sirve solo para versiones de Minecraft compatibles con Java 21.
4. Se abre **http://127.0.0.1:8788/** en tu navegador. En la primera entrada, crea tu propio PIN de 4 a 8 dígitos. El paquete no lleva un PIN compartido.
5. En **Nueva instancia**, elige nombre, tipo y versión, y pulsa **Crear servidor**. El panel descarga el servidor desde la fuente oficial (Mojang, Paper, Purpur, Fabric, Forge o NeoForge) y verifica el checksum; no se incluyen juegos ni mundos en este repositorio. Hace falta Internet.
6. Lee la [EULA de Minecraft](https://www.minecraft.net/en-us/eula). Si la aceptas, abre `instances\NOMBRE\eula.txt` y cambia `eula=false` a `eula=true`. El panel no la acepta por ti.
7. Pulsa **Encender**. Cuando termine el arranque, entra desde Minecraft Java de la misma versión con **localhost:25565**.

Mantén abierto el script mientras uses el panel. No crea tareas programadas, servicios ni inicio automático. No instala túneles ni cambia el router o el firewall.

## Qué trae

- **Ventanas, no scroll eterno**: Ajustes, Versión y tipo, Plugins y mods, Copias, Jugadores y Rendimiento abren como ventanas sobre la pantalla principal (también cómodo en el móvil).
- **Varias instancias**: cada una con su versión y su tipo (Vanilla, Paper, Purpur, Fabric, Forge, NeoForge). Cambiar de versión o tipo hace primero una copia del mundo.
- **Plugins y mods**: instala desde Modrinth con filtro por cargador y versión, o sube tus propios `.jar`. Activar, desactivar y borrar desde el panel.
- **Copias de seguridad**: automáticas cada 30 minutos con el servidor encendido y una al apagar, con rotación (7 recientes + 4 semanales). Opción de replicar cada copia a otra carpeta o disco. Restaurar crea siempre una instancia nueva: nunca sobrescribe un mundo.
- **Consola en vivo** con comandos, jugadores conectados y aviso cuando Mojang publica una versión nueva.
- **Importar un mundo** desde un `.zip`.
- **Solo tuyo**: escucha en localhost y, si tienes Tailscale, en tu IP de tailnet. Con PIN, sesiones con caducidad y cabeceras anti-CSRF.

## RAM recomendada

Empieza con **4 GB** para el servidor (valor inicial). En **Rendimiento y avanzado** puedes subirla y activar los flags de Java optimizados (Aikar). Deja RAM para Windows y para tu propio Minecraft si juegas en el mismo equipo.

## Conectar a tus amigos

### En la misma red de casa

Comparte la IP local del equipo (`ipconfig`) seguida de `:25565`. No uses `localhost` en otro ordenador.

### Por Internet

**Opción A: abrir el puerto del router.** Reenvía **TCP 25565** hacia el equipo y comparte tu IP pública seguida de `:25565`. Si tu operador usa CG-NAT puede no funcionar. No abras nunca el puerto del panel web (8788).

**Opción B: Tailscale.** Instala Tailscale en el equipo y en los de tus amigos; el panel ya escucha también en tu IP de tailnet, y ellos entran al servidor con `tu-ip-tailscale:25565`.

## Estructura

```
Iniciar.cmd / Iniciar.ps1   Lanzador: comprueba Node y Java, y abre el panel
mc-host.config.example.json Configuración inicial (se copia a mc-host.config.json)
panel/server.js             El panel (un solo proceso de Node, sin dependencias npm)
panel/world-import.js       Importador de mundos .zip
panel/public/index.html     La interfaz
instances/                  Tus servidores y mundos (no incluidos)
backups/                    Tus copias (no incluidas)
```

Sin dependencias npm: solo necesitas Node.js 20+ y Java 21+ (recomendado Java 25).
