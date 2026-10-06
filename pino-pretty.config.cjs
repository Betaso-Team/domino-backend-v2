// CÓMO SE LEEN LOS LOGS. Es `.cjs` y no un `.json` porque `customPrettifiers` son FUNCIONES; el CLI de
// pino-pretty busca este nombre además del `.pino-prettyrc` (`pino-pretty/bin.js`). Portado de truco.
//
// La regla de fondo: **el formato del cable no se toca** —JSON de una línea, que es lo que lo hace
// filtrable, greppeable y enviable a un panel—. Todo lo de acá es del LECTOR: lo usan el `npm run dev`
// y el atajo `./logs` que el despliegue deja en el servidor.
module.exports = {
  translateTime: "SYS:HH:MM:ss.l",
  messageFormat: "{msg}",

  // LO QUE NO SE MUESTRA: lo que vale igual en todas las líneas. `instance` NO está acá —aunque
  // tampoco se imprima en el cuerpo— porque `ignore` filtra el log ANTES de que corran los
  // prettifiers, y entonces el de abajo no tendría de dónde leerlo. Se omite con su propio prettifier.
  ignore: "pid,hostname,app,env,release",

  // EL COLOR ES UNA SEÑAL, NO DECORACIÓN: lo lleva el nivel y nada más.
  customColors:
    "fatal:bgRed,error:red,warn:yellow,info:white,debug:gray,trace:gray,message:white,property:gray",

  customPrettifiers: {
    // DE QUÉ INSTANCIA SALIÓ, pegado al reloj y ANTES del nivel: los nombres de nivel miden distinto
    // (`INFO`, `ERROR`, `DEBUG`), así que puesto después el indicador se corre de columna en cada
    // línea y deja de formar la columna que uno escanea. Se dibuja desde el gancho del NIVEL porque
    // no hay ranura entre el reloj y el nivel. Corriendo a mano no hay índice y no se dibuja nada.
    level: (_valor, _clave, log, { labelColorized, colors }) =>
      log.instance === undefined
        ? labelColorized
        : `${colors.gray(`[i${log.instance}]`)} ${labelColorized}`,

    // Y no se repite abajo. `undefined` hace que la clave se saltee entera; un string vacío dejaría
    // una línea `instance:` pelada.
    instance: () => undefined,
  },
};
