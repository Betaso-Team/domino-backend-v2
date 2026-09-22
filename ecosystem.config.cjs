// CÓMO SE LEVANTAN VARIAS INSTANCIAS DE ESTE SERVIDOR. Hasta acá "levantá N procesos" era
// conocimiento tribal: el repo sabía formar un clúster (Redis, `publicAddress`, el balanceador)
// pero no sabía arrancarlo.
//
// ES `.cjs` Y NO `.js`, y no es preferencia: el paquete es `"type": "module"`, así que un `.js`
// se lee como ESM y ahí `module.exports` NO EXISTE. pm2 lee su configuración con `require`, y el
// síntoma de equivocarse es un despliegue que no arranca, en la máquina de producción.
//
// MODO FORK Y NO CLUSTER, igual que truco y que v1: Colyseus necesita que cada proceso escuche
// en SU PROPIO puerto y se anuncie con SU PROPIA dirección, porque el jugador tiene que
// conectarse al proceso que hospeda SU sala. El modo cluster comparte un socket entre los
// workers, y con un socket compartido no hay a quién anunciar.
//
// LAS VARIABLES DE LA APLICACIÓN NO ESTÁN ACÁ: las lee el proceso del `.env` de al lado, con
// `process.loadEnvFile()` en `src/env.ts` —EL CONSUMIDOR LEE EL SUYO—, y es el mismo archivo que
// usa el compose. Un segundo lugar donde escribir `BETASO_BACKEND_JWT_SECRET` sería un segundo lugar donde
// tenerla desactualizada, y la que manda es siempre la última escrita.
//
// Y ES AL REVÉS DE COMO LO HACE v1, que llama a dotenv DESDE ESTE ARCHIVO y deja que el proceso
// hijo herede ese entorno de rebote: así la configuración de la aplicación depende de quién la
// arrancó, y `npm start` a mano no da lo mismo que `pm2 start`. Acá pm2 no aporta ninguna
// variable de producto; aporta `NODE_APP_INSTANCE`, que es suya.
//
// LO QUE FALTA CONFIRMAR CON INFRAESTRUCTURA ANTES DE SUBIR A DOS INSTANCIAS: el proxy de
// adelante tiene que rutear POR PREFIJO DE PATH, porque cada instancia se anuncia como
// `SERVER_ADDRESS/{su puerto}` (§`src/env.ts`). Es el esquema de v1, así que el proxy que ya lo
// rutea sirve sin aprender nada — pero si no lo hace, el que no llega es el CLIENTE y el
// servidor no se entera. Ver el README.
module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || "domino-backend",
      // EL ARCHIVO QUE SE EJECUTA. Es el mismo que `npm start`, que el `CMD` de la imagen y que
      // el único `entry` de tsup — los cuatro los pinea `src/entrypoint.test.ts`, porque
      // ninguno rompe el gate al desincronizarse.
      script: "dist/main.js",
      // DESDE DÓNDE CORRE, y acá `__dirname` SOLO NO ALCANZA en el servidor.
      //
      // El problema que resuelve es el mismo de siempre: tanto el `dist/` que corre como el
      // `.env` que `src/env.ts` lee son rutas RELATIVAS, resueltas contra el cwd, así que los
      // dos tienen que ser los del release que se está arrancando. Arrancarlo parado en otra
      // carpeta levanta el código de una release y la configuración de otra, sin un solo error.
      //
      // PERO `__dirname` NO ES EL SYMLINK: node resuelve los symlinks al cargar un módulo, así
      // que con `current ──► releases/<id>` esto da la CARPETA FÍSICA del release, una distinta
      // en cada despliegue. Y pm2 guarda la ruta ABSOLUTA del script y NO LA ACTUALIZA AL
      // RECARGAR: truco lo descubrió desplegando cuatro veces al servidor de dev, donde después
      // de voltear el symlink y recargar las dos instancias seguían corriendo la release
      // anterior. Re-aplicar el archivo de configuración —que era la mitigación planeada— no
      // ayuda.
      //
      // La solución es que LA RUTA QUE SE LE DA NUNCA CAMBIE: `deploy-remote.sh` invoca a pm2
      // con `PM2_CWD` apuntando al symlink `current`, pm2 guarda esa ruta —que es la misma para
      // siempre— y el symlink es lo que decide qué versión hay del otro lado. Y como eso estuvo
      // mal una vez, el despliegue lo CHEQUEA en vez de asumirlo, con `/proc/<pid>/cwd`.
      //
      // `__dirname` queda de respaldo para cuando se lo arranca a mano desde una copia del
      // repo, que es el caso del README y el de esta máquina: ahí no hay symlink ni releases, y
      // el directorio de este archivo ES el del proyecto.
      cwd: process.env.PM2_CWD || __dirname,
      // CON QUÉ NODE CORRE LA APP. Por defecto, el de pm2 — que es el del DEMONIO y no el de
      // quien despliega, y puede no ser el que probó la suite: truco encontró un servidor donde
      // el demonio corría con un node 20 del sistema mientras el CI y el Dockerfile usaban el 22,
      // y colyseus 0.18 declara `"node": ">= 22.x"`. Ponerlo es lo que da paridad; no ponerlo es
      // aceptar el de pm2, que `engines` acota por abajo y `src/entrypoint.test.ts` pinea.
      //
      // Es opcional a propósito: en una máquina donde el demonio ya corre el node correcto,
      // fijarlo obligaría a actualizar esto en cada upgrade de node.
      ...(process.env.NODE_INTERPRETER ? { interpreter: process.env.NODE_INTERPRETER } : {}),
      time: true,
      watch: false,
      exec_mode: "fork",
      instances: Number.parseInt(process.env.PM2_INSTANCES, 10) || 1,

      // EL PROCESO AVISA CUANDO TERMINÓ DE LEVANTAR. El `process.send('ready')` lo manda
      // `@colyseus/tools` al final de su `listen()`; sin `wait_ready`, pm2 daría la instancia
      // por lista al arrancarla y le mandaría tráfico antes de que escuche.
      //
      // CUIDADO CON EL OTRO LADO DE ESTO: si Redis está configurado y caído, el proceso nunca
      // llega a escuchar —ioredis reintenta para siempre— y pm2 lo reinicia en bucle al vencer
      // este plazo. El síntoma es una instancia que "no arranca" sin un error propio.
      wait_ready: true,
      listen_timeout: 10_000,

      // EL APAGADO. `shutdown_with_message` hace que pm2 mande un MENSAJE `shutdown` en vez de
      // una señal, y ESA es la rama que `src/main.ts` tuvo que agregar: sin ella el drenado no
      // correría en ningún `pm2 reload` —o sea en ningún deploy— y las salas nunca se
      // dispondrían. Una partida que muere sin veredicto es un reembolso que nunca se anuncia.
      //
      // `kill_timeout` es cuánto espera pm2 antes de matar de verdad: es el presupuesto del
      // drenado. Medido con Mongo y Redis reales, el apagado tarda decenas de milisegundos, así
      // que 5 s es holgura y no una apuesta.
      shutdown_with_message: true,
      kill_timeout: 5_000,

      // CADA INSTANCIA ESCUCHA EN `PORT + NODE_APP_INSTANCE`, y el que suma no es pm2 ni
      // nosotros: es `@colyseus/tools`, adentro de su `listen()`. pm2 solo aporta el índice.
      // `PORT` es entonces la BASE, y con dos instancias no es el puerto de la segunda
      // (§`src/env.ts`). No se configura acá: sale del `.env`.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
