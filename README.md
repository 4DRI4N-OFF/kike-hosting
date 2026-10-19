# Kike Hosting

Panel local para alojar un servidor de **Minecraft Java** en Windows. Diseño claro: tarjetas redondas, controles sencillos, consola en vivo y acceso con PIN.

## Antonio: empieza aquí

1. En GitHub, pulsa **Code → Download ZIP**. Extrae toda la carpeta en una ubicación tuya, por ejemplo `Documentos\KikeHosting`. No lo ejecutes dentro del ZIP.
2. Haz doble clic en **Iniciar.cmd**. El script comprueba Node.js 20+ y Java 21+. Si falta alguno, ofrece instalarlo con winget, pero solo si respondes `s`. Windows puede pedir permiso de administrador.
3. Si winget no está disponible, instala [Node.js LTS](https://nodejs.org/) y [Eclipse Temurin](https://adoptium.net/temurin/releases/) y vuelve a abrir el script. Recomendado: **Java 25** para versiones recientes. Java 21 sirve solo para versiones de Minecraft compatibles con Java 21.
4. Abre **http://127.0.0.1:8787/** en tu navegador. En la primera entrada, crea tu propio PIN de 4 a 8 dígitos. El paquete no lleva un PIN compartido.
5. En **Nueva instancia**, elige nombre y versión y pulsa **Crear servidor**. El panel descarga el `server.jar` oficial de Mojang al crear cada instancia; no se incluyen juegos ni mundos en este repositorio. Hace falta Internet.
6. Lee la [EULA de Minecraft](https://www.minecraft.net/en-us/eula). Si la aceptas, abre `instances\NOMBRE\eula.txt` y cambia `eula=false` a `eula=true`. El panel no la acepta por ti.
7. Pulsa **Encender**. Cuando termine el arranque, entra desde Minecraft Java de la misma versión con **localhost:25565**.

Mantén abierto el script mientras uses el panel. No crea tareas programadas, servicios ni inicio automático. No instala túneles ni cambia el router o el firewall.

## RAM en un portátil de 20 GB

Empieza con **4 GB** para el servidor: ya es el valor inicial. En **Ajustes → Rendimiento y editor avanzado** puedes poner 6 GB si hace falta y el portátil no se queda sin memoria. Deja RAM para Windows y para tu Minecraft si juegas en el mismo portátil. No asignes los 20 GB al servidor. Los cambios se aplican al siguiente arranque del servidor.

## Conectar a tus amigos

### En la misma red de casa

Comparte la IP local del portátil, que puedes ver con `ipconfig`, seguida de `:25565`. No uses `localhost` en otro ordenador: allí apuntaría a ese otro ordenador.

### Por Internet: elegir una opción

**Opción A: abrir el puerto del router.** Reserva una IP local para el portátil y reenvía **TCP 25565** hacia esa IP. Permite únicamente el Java del servidor en el firewall según tu red. Comparte tu IP pública seguida de `:25565`. Esa IP puede cambiar. Si tu operador usa CG-NAT, el reenvío puede no funcionar; consulta al operador o usa un túnel. No abras el puerto del panel web.

**Opción B: playit.gg.** Sigue la [guía oficial de Minecraft Java](https://playit.gg/support/how-to-setup-a-mc-server): descarga el agente desde el sitio oficial, ejecútalo y vincúlalo a tu propia cuenta. Crea un túnel de tipo Minecraft Java dirigido a **127.0.0.1:25565**. Comparte con tus amigos la dirección que te asigne playit, no la del panel. El agente y el servidor deben seguir abiertos. Revisa sus condiciones y tarifas vigentes antes de elegir opciones de pago. Este paquete no crea cuenta ni túnel.

Tailscale es otra opción si todos los participantes tienen acceso a la misma red privada: usa la IP Tailscale de tu portátil con `:25565`.

## Seguridad y lista blanca

- Conserva **Modo online** activado: verifica las cuentas de Minecraft.
- Activa **Lista blanca** y añade los nombres exactos de tus amigos antes de compartir una dirección pública.
- No des operador a personas que no deban tener control del servidor.
- El PIN protege el panel, no sustituye a la lista blanca del juego. No publiques el puerto del panel ni lo pases por un túnel de Internet. Su conexión HTTP no cifra el PIN; úsalo en el propio PC o dentro de una red privada de confianza.
- No compartas `mc-host.config.json`: contiene el hash y la sal del PIN. Tampoco subas `instances`, `backups` ni registros. `.gitignore` los excluye.
- Las copias de seguridad de este panel son locales. Guarda también una copia fuera del portátil antes de cambios importantes.

## Puertos y varias copias

El panel usa **8787**, configurable con `PANEL_PORT`. Por ejemplo, desde PowerShell en la carpeta:

```powershell
$env:PANEL_PORT = '8790'
.\Iniciar.ps1
```

El juego usa **25565** por defecto. Con el servidor apagado, se puede cambiar `server-port` en `instances\NOMBRE\server.properties` (también desde el editor avanzado). Si cambias el puerto, cambia igualmente el reenvío o túnel y la dirección que compartes.

**No ejecutes dos servidores en el mismo puerto.** Cada copia del panel tiene sus instancias y configuración independientes. El script no detiene otros programas si un puerto está ocupado.

## Qué incluye el panel

Instancias Vanilla, encendido/apagado/reinicio, consola, jugadores, ajustes, operadores, lista blanca, datapacks, RAM, copias automáticas/manuales y restauración como instancia nueva. Sin dependencias npm. El servidor escucha en loopback y, si está instalado, en la IP Tailscale del equipo.

## Solución de problemas

- **UnsupportedClassVersionError:** la versión de Java es demasiado antigua para esa versión del juego. Instala una compatible y vuelve a abrir el script.
- **Address already in use:** hay otro programa en ese puerto. Detén tu otro servidor cuando sea seguro o elige un puerto distinto.
- **No puedes entrar desde fuera:** comprueba primero `localhost:25565`, luego firewall, router/CG-NAT o el destino del túnel. No desactives todo el firewall.
- **PIN olvidado:** no se incluye una puerta trasera. Conserva tus copias y recupera el acceso solo en el equipo que administras.
- Para cerrar: detén primero el Minecraft y después usa **Apagar el panel**. No cierres a la fuerza mientras guarda un mundo.

## Contenido y licencia

Paquete limpio: sin PIN, credenciales, direcciones personales, mundos, instancias, backups ni archivos de Minecraft. Los datos se crean en tu propia carpeta al usarlo.

No se ha añadido una licencia de software. Que el código sea visible no concede una licencia general para redistribuirlo; solicita permiso al titular. Minecraft, Java y playit pertenecen a sus respectivos titulares. Este panel no es un producto oficial de Mojang o Microsoft.
