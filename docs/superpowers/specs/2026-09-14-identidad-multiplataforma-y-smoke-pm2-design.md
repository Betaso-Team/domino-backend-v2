# Identidad multiplataforma, liquidación por `rateId` y smoke real con PM2

> **Spec de diseño** · 2026-09-14 · Aprobado por el usuario en tres secciones.
>
> Este documento es posterior al diseño general del 2026-09-09 y lo corrige solamente donde aquel
> dejó la identidad externa fuera del estado y tomó un UUID interno de Betaso como identidad canónica.
> La decisión nueva es que la identidad de negocio es siempre `{ platformId, userUuid }` y que Betaso
> es una plataforma más. El motor puede conservar un identificador opaco de asiento, pero nunca usarlo
> para cobrar, premiar ni identificar una cuenta fuera de la partida.
>
> ⚠ **SUPERSEDIDO EN SU CONVENCIÓN MONETARIA** por
> [`2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design.md`](./2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design.md),
> §«Supersesión de la convención UC». Todo lo que este documento dice sobre `*UcMinor` y sobre
> «enteros con dos decimales implícitos» describe un supuesto que resultó **falso contra producción**:
> en el v1 que este repo reemplaza, `entryFee: 10` significa **10 UC** y no `0,10 UC`, y el catálogo
> productivo tiene montos decimales. La Tarea 1 de aquel incremento renombró `entryFeeUcMinor`,
> `prizeUcMinor` y `amountUcMinor` a `entryFee`, `prize` y `amount`, sin escalar ningún número.
>
> **No se borra el registro de la decisión previa**: era razonable cuando se tomó —evitar coma
> flotante en dinero es doctrina sana— y lo que la invalidó no fue un argumento sino leer el backend
> v1 en disco. Lo que sí sobrevive intacto de esta sección es el piso de magnitud: los montos siguen
> rechazándose por encima de `Number.MAX_SAFE_INTEGER`, porque ahí dos importes distintos son el
> mismo número. Lo que se cayó es la escala, no la guarda.

## 1. Objetivo

Cerrar dos huecos del incremento actual:

1. `PlayerState`, `Identity` y `DominoRoomOptions` solo conocen un `userId`; no pueden representar dos
   usuarios de plataformas distintas con el mismo UUID ni llevan el perfil y la moneda congelados al
   crear la mesa.
2. Los E2E levantan Colyseus dentro de Vitest. Prueban el wire y el engine, pero no el artefacto
   `dist/main.js` ejecutado por PM2 detrás del proxy que exige `publicAddress`.

El resultado debe seguir siendo un backend de juego, no una segunda plataforma: no consulta usuarios,
tasas ni wallets de Betaso. Un futuro orquestador hace esas consultas, cobra, crea la partida y liquida
su resultado.

## 2. Alcance

### Entra en este incremento

- Identidad compuesta `{ platformId, userUuid }` en autenticación y en el contrato de creación.
- Snapshot de presentación y moneda por participante.
- Un único `rateId` inmutable por partida.
- Montos UC como enteros de punto fijo con dos decimales implícitos.
- Proyección agnóstica de plataforma para recompensa o reembolso.
- Smoke automático de una partida 2P completa contra Docker + PM2 + Nginx.
- El smoke como gate anterior al deploy.

### No entra

- Construir el orquestador.
- Consultar Betaso, resolver el valor de una tasa o mover dinero real.
- Implementar adaptadores de wallets de plataformas.
- Diseñar el libro contable, reintentos u outbox del orquestador.
- El Nginx de producción: este incremento entrega una configuración de prueba que verifica el contrato
  de rutas; infraestructura decide dónde vive el proxy real.
- Extender el juego a 4P. Los tipos no deben impedirlo, pero el smoke certifica la rebanada 2P actual.

## 3. Contrato de identidad

### 3.1 Referencia de plataforma

La única identidad válida fuera de una partida es:

```ts
interface PlayerRef {
  readonly platformId: string;
  readonly userUuid: string;
}
```

Los dos campos son obligatorios, no vacíos y se comparan como una pareja. `userUuid` solo nunca es una
clave global. La plataforma propia usa un `platformId` estable, por ejemplo `betaso`; el smoke usa
`smoke` dentro de su entorno aislado.

El `playerId` actual puede sobrevivir como identificador opaco del protocolo de juego. Lo genera el
backend al normalizar la creación, se guarda con la configuración reproducible y solo identifica un
asiento dentro de esa partida. No se devuelve a una plataforma como identidad de cuenta y ninguna
operación monetaria se indexa por él. Mantenerlo evita reescribir reglas que solo necesitan distinguir
asientos; la pareja original sigue siendo la autoridad de negocio.

### 3.2 Snapshot del participante

El orquestador entrega al crear la partida:

```ts
interface MatchParticipant {
  readonly platformId: string;
  readonly userUuid: string;
  readonly displayName: string;
  readonly username?: string;
  readonly profilePicture?: string;
  readonly currency: string;
}
```

- `displayName` es obligatorio y reemplaza `name + lastname` de v1.
- `username` y `profilePicture` son opcionales porque una plataforma puede no tenerlos.
- `currency` es la moneda con la que se cobró a ese usuario. Queda congelada para toda la partida y
  es la única moneda en la que se lo puede recompensar o reembolsar.
- El juego no completa datos faltantes consultando una base externa.

`PlayerState` conserva ese snapshot. Los campos de presentación son públicos para los clientes de la
mesa. `platformId`, `userUuid` y `currency` existen en el estado del servidor, pero no se sincronizan
al rival: el wire de juego usa el `playerId` opaco. Así se cumple el nuevo contrato sin publicar la
cuenta ni el mercado de otro jugador.

### 3.3 Autenticación

`Identity` pasa a representar `platformId` y `userUuid`. En el JWT de transición, `sub` contiene
`userUuid` y un claim obligatorio contiene `platformId`; el nombre, avatar y moneda no se confían al
token del cliente, sino al snapshot que entregó el creador autorizado de la partida.

Al unirse, la sala busca una coincidencia exacta de ambos campos. Un token válido para el mismo
`userUuid` en otra plataforma no ocupa el asiento. `TokenVerifier` continúa siendo el puerto: cambiar
el emisor o validar un token del futuro orquestador no entra al core.

## 4. UC, tasa y liquidación

### 4.1 Representación de UC

⚠ **ESTA SUBSECCIÓN ESTÁ SUPERSEDIDA.** Ver la nota del encabezado: producción v1 no usa escala. Lo
que sigue se conserva como registro de la decisión previa, no como contrato vigente. El vigente es
`entryFee`/`prize`/`amount` como números finitos no negativos, decimales incluidos, con techo
`Number.MAX_SAFE_INTEGER`.

Todo monto UC es un entero seguro de JavaScript, no negativo y con escala fija de dos decimales:

```text
1234 UcMinor = 12,34 UC
```

Los campos monetarios llevan el sufijo `UcMinor`, por ejemplo `entryFeeUcMinor` y
`prizeUcMinor`. No se usan números de coma flotante para representar UC. El contrato de esta rebanada
2P interpreta `prizeUcMinor` como el premio del ganador; cuando llegue 4P deberá definir y probar si el
valor es por ganador o por equipo antes de reutilizarlo.

### 4.2 Snapshot de tasas

La partida guarda un solo `rateId` UUID, inmutable y a nivel de mesa. Ese UUID identifica el conjunto
de tasas que Betaso tenía al cobrar; no se guarda una copia de cada `ucRate` en `PlayerState`.

Para cualquier participante, la conversión se resuelve exclusivamente con:

```text
(rateId de la partida, currency del participante)
```

Esto copia la propiedad correcta de v1: entrada y premio usan el mismo snapshot. No copia su
acoplamiento: v1 consulta Postgres, tasas y wallet desde la sala; v2 no hace ninguna de esas llamadas.

### 4.3 Resultado para el orquestador

La capa `network/`, no el motor, proyecta el veredicto a una instrucción con:

- `matchId` y `rateId`.
- Tipo `REWARD` o `REFUND`.
- Por entrada: `platformId`, `userUuid`, `currency` y `amountUcMinor`.
- Una clave idempotente formada por `matchId + platformId + userUuid + tipo`.

Para una partida 2P resuelta, el ganador recibe `prizeUcMinor`. Para `MATCH_ABORTED`, cada participante
de la sala recibe `entryFeeUcMinor`: una sala solo puede existir después de que todos los cobros fueron
confirmados. El juego produce el hecho; el orquestador es quien persiste la idempotencia, convierte UC
consultando a Betaso y ordena el movimiento en cada plataforma. Si el fallo ocurre antes de crear la
sala, el orquestador reembolsa directamente los cobros confirmados porque todavía no existe un juego
capaz de emitir `MATCH_ABORTED`.

La entrega remota de esa instrucción queda fuera de este incremento. La proyección pura sí entra porque
fija el contrato, permite probar recompensa/reembolso sin dinero real y evita que el futuro adaptador
tenga que interpretar el árbol de Colyseus.

## 5. Flujo del orquestador

### Creación

1. Recibe y valida cada `{ platformId, userUuid }`.
2. Obtiene perfil y `currency` desde la plataforma dueña del usuario.
3. Consulta a Betaso el conjunto actual y congela su `rateId`.
4. Convierte `entryFeeUcMinor` para cada `currency` usando ese `rateId`.
5. Ordena todos los cobros con claves idempotentes.
6. Solo si todos confirman, crea la partida con los snapshots y términos congelados.
7. Si un cobro falla, o falla la creación después de cobrar, cancela y ordena el reembolso de todos
   los cobros confirmados. No queda una sala parcialmente financiada.

### Cierre

- `MATCH_RESOLVED`: recompensa al ganador en su `currency` original usando el mismo `rateId`.
- `MATCH_ABORTED`: reembolsa a cada participante cobrado en su `currency` original.
- Una caída o reintento no cambia `currency`, `rateId` ni los montos UC.

## 6. Smoke real del deploy

### 6.1 Topología

Una composición separada de la de desarrollo levanta:

```text
smoke-client -> Nginx -> PM2 (dist/main.js × 2)
                            |-> Redis
                            `-> Mongo
```

Se usa un archivo Compose adicional, no perfiles en `compose.yaml`: la ausencia de perfiles en el
compose operativo sigue siendo una decisión válida. La imagen tendrá un target de smoke que añade PM2
al runtime sin engordar la imagen normal.

Nginx acepta el endpoint inicial y enruta WebSocket/HTTP por los prefijos anunciados por cada proceso:
`/2567` y `/2568`. La prueba consulta además la readiness de ambas instancias por separado. Así prueba
la pieza que el Docker actual de un solo proceso no puede ejercer.

### 6.2 Activación segura

`RUN_ENGINE_SMOKE=1` activa el runner y su stack aislado. La flag no cambia el comportamiento del
backend, no registra endpoints de prueba y no salta autenticación. El runner conoce únicamente el
secreto efímero de esa composición y actúa como un orquestador mínimo.

Sin la flag el runner se niega a ejecutar. Nunca reutiliza `.env` de producción ni llama una wallet.

### 6.3 Partida automática

El runner, usando el SDK público de Colyseus:

1. Espera `/ready` en los dos procesos.
2. Crea una partida determinista 2P con dos plataformas y monedas distintas, un `rateId` fijo y montos
   UC conocidos.
3. Firma dos identidades de prueba y conecta ambos clientes a través de Nginx.
4. Verifica que cada token ocupa únicamente su asiento y que los datos privados del rival no llegan.
5. Envía `REVEAL_TILES` con ambos clientes.
6. Juega fichas legales; roba o pasa cuando corresponda, hasta `FINISHED`, sin acceder al estado
   interno del proceso.
7. Afirma ganador, marcador, `MATCH_RESOLVED`, historial y proyección `REWARD`, incluida la misma
   pareja `{ platformId, userUuid }`, `currency`, `rateId` y `prizeUcMinor`.
8. Ejercita por separado la proyección `REFUND` de un aborto; no mueve dinero.

Cada espera tiene plazo. Ante fallo se imprime la etapa, las fases vistas y las últimas acciones; el
runner sale distinto de cero. La composición se apaga y elimina sus recursos efímeros aun cuando la
partida falle.

## 7. Validación y errores

- Se rechaza la creación si falta un campo obligatorio, un monto no es entero seguro/no negativo,
  `rateId` no es UUID o hay referencias de jugador duplicadas.
- Una `currency` no vacía se conserva exactamente; el juego no mantiene un catálogo propio de monedas.
- Una vez creada la sala no existe comando que modifique identidad, perfil financiero, montos o tasa.
- Un token cuya pareja no coincide con un asiento se rechaza antes de tocar el estado.
- Nunca se ignora una rama monetaria desconocida: sin veredicto válido se produce reembolso, no premio.
- El smoke no demuestra que una wallet real funcione; demuestra engine, wire, auth, estado, historial,
  artefacto, PM2 y proxy.

## 8. Estrategia de pruebas y gates

El orden de implementación sigue TDD y el gate del repo:

1. Tests de contrato/validación y génesis del snapshot.
2. Tests de vistas: identidad financiera privada y presentación pública.
3. Tests de autenticación con colisión de `userUuid` entre plataformas.
4. Tests de `rateId`, enteros UC y proyecciones `REWARD`/`REFUND`.
5. Actualización de E2E, replay y golden existentes.
6. `npm run typecheck && npm test && npm run lint && npm run build`.
7. Smoke Docker/PM2/Nginx con `RUN_ENGINE_SMOKE=1`.

El workflow de CI ejecuta el smoke después del build y antes de empaquetar el release. Como
`deploy.yml` ya depende de CI, ningún entorno acepta un artefacto que solo pasó los tests dentro de
Vitest.

## 9. Continuidad del trabajo

El plan de implementación será la autoridad operativa y tendrá tareas numeradas, estado y comandos de
verificación. Antes de empezar código, `AGENTS.md` apuntará a ese plan como incremento activo y
registrará la decisión que reemplaza a la sección 4.1 anterior.

Después de cada tarea se dejarán el commit y el estado del plan. Al cerrar o interrumpir el incremento,
`AGENTS.md` registrará:

- última tarea y commit completados;
- baseline real de tests;
- verificaciones locales y smoke ejecutadas;
- cualquier deuda o paso pendiente, con su condición exacta de reanudación.

Así una sesión posterior puede continuar desde el primer paso no cumplido sin reconstruir estas
decisiones desde la conversación.

## 10. Criterios de aceptación

- Dos jugadores con el mismo `userUuid` y distinto `platformId` son identidades diferentes.
- Las respuestas de orquestación conservan exactamente el `platformId` y `userUuid` recibidos.
- Perfil y moneda nacen del snapshot; el backend no consulta Betaso.
- La moneda de cobro es la de recompensa/reembolso y no cambia durante la partida.
- Toda conversión usa el único `rateId` congelado de la mesa.
- ⚠ ~~Los montos UC son enteros de dos decimales implícitos.~~ **Supersedido** (ver encabezado y
  §4.1): son números finitos no negativos, decimales incluidos, con techo `MAX_SAFE_INTEGER`.
- Un cobro parcial nunca abre partida y ordena reembolso.
- El rival no recibe identidad externa ni moneda; sí recibe la presentación pública.
- Una partida 2P completa termina contra `dist/main.js` en dos procesos PM2 detrás de Nginx.
- El smoke falla de forma observable y bloquea el deploy.
- Spec, plan y `AGENTS.md` permiten retomar cualquier trabajo pendiente.
