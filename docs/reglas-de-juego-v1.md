# Reglas del Dominó Betaso

> **Versión:** v1 — primera redacción. Extraída del código de `Betaso-Domino-Backend`
> a fecha 2026-09-09, con las divergencias entre 2P, 4P y torneo anotadas.
>
> **Revisión 2026-09-10.** Se cerraron dos decisiones nuevas —**7** (el tiempo extra pasa a ser una
> reserva de partida, cambio deliberado respecto del v1) y **8** (qué significa "partida válida", y que
> el cobro sale del motor)— y se agregaron dos secciones que la primera redacción no tenía: **§9 el
> catálogo del historial** y **§10 los tres consumidores**. Las dos existen por el mismo motivo: el
> historial de jugadas del v1 —tres actos distintos en un tipo, discriminados por dos booleanos, y
> sincronizado a todos con la ficha robada dentro— es el defecto que más incomodó en producción, y no
> estaba descrito en ninguna parte.
>
> **Y se escribió §3.1, la VENTANA DE REPARTO**, que es paridad con el v1
> (`initialTilesTimeRemaining` + `on-reveal-tiles.ts`) y que la primera redacción no trataba como
> regla. Es el control que impide mirar el reparto y salirse gratis, y de ella sale la regla que más
> vale escribir con todas las letras en un juego con dinero: **si no la levanta nadie, no gana nadie.**

Convenciones: "2P" = `src/rooms/schema/domino/two-players/*`, "4P" = `src/rooms/schema/domino/four-players/*`, "torneo" = `src/tournaments/game/*`. Todas las rutas son relativas a la raíz del repo.

## 1. El material

### 1.1 El set de fichas

El set es el clásico de dominó doble-seis: 28 fichas, cada una un par `[left, right]` con valores de 0 a 6, sin repetición (`src/shared/constants/domino.constants.ts:1-38`, `DOMINO_SET_SIZE = 28`, `MIN_TILE_VALUE = 0`).

Una ficha (`Tile`, `src/rooms/schema/domino/piece.ts:8-57`) expone:
- `isDouble()`: `left === right` (`piece.ts:19-21`).
- `getValue()`: `left + right`, los "pips" de la ficha (`piece.ts:28-30`).
- `canConnectWith(number)`: si algún lado coincide con `number` (`piece.ts:33-35`).
- `getOppositeNumber(lockedNumber)`: el lado libre de una ficha ya colocada (`piece.ts:42-48`).

El mazo se construye y valida con `DominoUtils` (`src/shared/utils/domino.utils.ts:10-62`):
- `createDeck()` arma las 28 fichas desde `DOMINO_SET`, corre `validateDeck()` (revienta con `Error` si no hay exactamente 28 fichas únicas, `domino.utils.ts:30-48`) y mezcla con Fisher-Yates (`domino.utils.ts:53-62`).
- Los tres modos usan el mismo mazo sin variación: 2P y 4P llaman `DominoUtils.createDeck()` en `initializeDeck()` (`two-players/domino-room-state.ts:204-217`, `four-players/domino-room-state.ts:321-332`); el torneo hace lo mismo en `tournament-game.ts:139-151`.

### 1.2 La mano y el pozo

- **2P**: 7 fichas por jugador (`TILES_PER_PLAYER_2P_INITIAL = 7`, `domino.constants.ts:41`; reparto en `two-players/domino-room-state.ts:222-233`). Sobran 28 − 14 = 14 fichas, que quedan en `this.deck` como pozo del que se puede robar (`drawTileFromDeck`, `two-players/domino-room-state.ts:239-247`; el estado sincroniza `deckSize` al cliente, campo declarado en `two-players/domino-room-state.ts:55`).
- **4P**: también 7 fichas por jugador (`TILES_PER_PLAYER_4P_INITIAL = 7`, `domino.constants.ts:42`; reparto en `four-players/domino-room-state.ts:337-348`), pero 4 × 7 = 28 = el set completo. **No hay pozo**: el mazo queda vacío tras repartir. Esto no es una simplificación de la lectura — el propio schema del estado 4P no declara un campo `deckSize` (compárese `four-players/domino-room-state.ts:37-69` con `two-players/domino-room-state.ts:33-65`, que sí lo tiene en la línea 55), y no existe un comando "cargar ficha" para 4P: el directorio `four-players/commands/` no tiene un archivo `on-load-tile.ts` (a diferencia de `two-players/commands/on-load-tile.ts` y `tournaments/game/commands/on-load-tile.ts`).
- **Torneo**: igual que 2P — 7 fichas por jugador reutilizando `TILES_PER_PLAYER_2P_INITIAL` (`tournament-game.ts:153-164`), mismo mecanismo de pozo y robo (`drawTileFromDeck`, `tournament-game.ts:166-174`; comando `tournaments/game/commands/on-load-tile.ts:1-46`, copia funcional del de 2P).

## 2. La mesa

### 2.1 2 jugadores

`playersQuantity` queda fijo en 2 (`const MAX_PLAYERS = 2`, `src/rooms/domino-two-room.ts:45`, asignado a `this.state.playersQuantity` en `domino-two-room.ts:108`). Un jugador tiene un único rival: `getRivalPlayer()` devuelve "el otro" de los dos (`two-players/domino-room-state.ts:120-123`).

### 2.2 4 jugadores por parejas — el orden de los asientos asigna los equipos

**Este título, tal como está redactado en el plan, no describe lo que hace el código.** Lo dejo igual porque la estructura del documento es la pactada, pero la regla real es otra — ver el hallazgo abajo.

`playersQuantity` queda fijo en 4 (`const MAX_PLAYERS = 4`, `src/rooms/domino-four-room.ts:44`, asignado en `domino-four-room.ts:113`). Lo que asigna equipos y posiciones **no es el orden de llegada/asiento**, sino un sorteo que corre una sola vez, al arrancar la partida:

- `OnReadyCommand.startGame()` llama a `assignTeams()` (`four-players/commands/on-ready.ts:45`), que mezcla el arreglo de jugadores con Fisher-Yates y luego reparte posiciones fijas: posiciones 0 y 2 del arreglo mezclado → `TEAM_1` con `playerNumber` 1 y 3; posiciones 1 y 3 → `TEAM_2` con `playerNumber` 2 y 4 (`four-players/commands/on-ready.ts:70-101`). El intercalado (1,3 vs 2,4) es intencional: como el turno rota por `playerNumber` en orden circular (1→2→3→4→1, `four-players/domino-room-state.ts:156-172, 253-255, 280-298`), cada jugador siempre tiene un rival a su izquierda y a su derecha y a su compañero "cruzado" — la disposición física correcta del dominó en pareja, lograda por sorteo en vez de por asiento.
- Única excepción: si la sala nace de una revancha explícita, se preserva el `teamId`/`playerNumber` de la partida anterior en vez de resortear (`applyRematchRoster()`, `four-players/commands/on-ready.ts:108-134`).

El puntaje de un equipo se lee de un solo jugador "capitán" (`playerNumber` 1 o 2) porque ambos compañeros reciben siempre el mismo incremento en la misma ronda (`getTeamScore`, `four-players/domino-room-state.ts:203-206`; el incremento simultáneo ocurre en `finishCurrentRound`, `four-players/domino-room-state.ts:421-426`).

## 3. La ronda

### 3.1 Reparto y la VENTANA DE REPARTO

Ver §1.2. En los tres modos, repartir mezcla el mazo primero (`DominoUtils.createDeck()`), anuncia `SHUFFLE_TILES` al cliente y espera 3 segundos antes de asignar fichas (`two-players/domino-room-state.ts:204-217`, `four-players/domino-room-state.ts:321-332`, `tournament-game.ts:139-151` — los tres con el mismo `setTimeout(…, 3000)`).

**La ventana de reparto (regla del v2, con paridad de v1).** Al empezar la partida las fichas se
reparten pero **no se hacen públicas a nadie**: cada jugador levanta las suyas con `REVEAL_TILES`
dentro de **15 s**. Mientras falte alguien, la ronda no arranca. Al vencer el plazo, el que no las
levantó **se retira**. Es de la **ronda 1** nada más: de la 2 en adelante el reparto revela solo,
porque ya se demostró que están.

El v1 tiene la mecánica (`initialTilesTimeRemaining` = 15, `commands/on-reveal-tiles.ts`,
`on-timeout-reveal.ts`) y el v2 la conserva con la forma de truco (negocio v27 §12.7).

**Para qué, si el reloj del turno ya retira al ausente.** Porque el del turno mira a **UNO**: al que
le toca jugar. En dominó eso deja un hueco grande — el que abre la ronda puede tardar sus 60 s, y
recién ahí el rival descubre que enfrente no hay nadie. La ventana los mira a **todos a la vez**, y a
los 15 s.

**Y en dominó tiene una segunda razón que en truco pesa menos: el fraude de mirar y salirse.** Tus 7
fichas te dicen bastante sobre si te conviene jugar esa mano. Si ver la mano fuera gratis y salirse no
costara nada, se podría elegir con qué reparto jugar y con cuál no. Con la ventana, levantar las
fichas **es** la prueba de presencia, y quien no la da queda retirado antes de que la mano empiece.

Los tres desenlaces al vencer:

| Qué quedó | Qué pasa |
|---|---|
| Gente de los dos lados | la mano **sigue**, con uno menos (4P) |
| Un lado vacío | **forfeit** a favor del otro, sin que se haya jugado una ficha |
| **Nadie** | **no gana nadie**: la mesa se muere sin veredicto y se reembolsa |

**El tercero es el que hay que escribir con todas las letras: si no la levanta nadie, NO GANA NADIE.**
No es una cortesía — es que el juez tiene que preguntar por los dos equipos retirados **antes** que
por uno. Preguntando por uno primero, el orden de evaluación corona al otro y esa partida —que nadie
jugó— **paga premio**. En un juego con dinero, eso es plata que sale por un bucle que no miró el caso.

Levantar las fichas es el único revelado del juego que **no le muestra nada a nadie más**: las fichas
van a su dueño y a nadie. Lo que agrega a la mesa no es información, es la prueba de que el jugador
está ahí.

> **Es config, no regla apagable a mano.** `isDealWindowEnabled` va encendido en **toda** mesa —no
> depende del modo ni de la cantidad de asientos, a diferencia del sorteo de equipos—. Es config para
> que producto pueda apagarla sin deploy y para que los tests del motor no paguen la ceremonia; no
> viaja en las opciones de la sala, justamente para que nadie pueda olvidarla y apagar un control
> antifraude en silencio.

#### 3.1.1 Los únicos dos revelados que existen en dominó

La ventana de reparto es el **único** revelado voluntario del juego. Vale escribir la lista completa,
porque el v2 se porta de truco y truco tiene varios más:

| Revelado | Cuándo | A quién |
|---|---|---|
| **Levantar las fichas** (`REVEAL_TILES`) | ventana de reparto, ronda 1 | **solo al dueño** |
| **Las manos al cerrar la ronda** | automático, al contar los pips | a todos |

Y esto **NO existe en dominó**, aunque exista en truco:

- **Mostrarle una ficha a tu compañero.** No hay seña legal: la información que un jugador tiene sobre
  su propia mano no se comparte por ningún canal del juego.
- **Intercambiar una ficha con tu compañero** (el `SHARING_CARD` / `SELECT_SHARED_CARD` del truco de
  4). La mano que te tocó es la que jugás.
- **Jugar una ficha tapada**, o cualquier jugada con valor oculto (el `TAPADO` y el pegado del truco).
  Una ficha en la mesa es pública, siempre y para todos.

**Consecuencia de diseño que sale de esta lista:** la audiencia de visibilidad del motor tiene **dos**
valores —el jugador y la mesa— y no tres. No hay audiencia de EQUIPO, porque no hay ninguna mecánica
que le muestre algo a tu compañero y no a la mesa. La primera redacción del plan la traía de truco,
con un `case` inalcanzable y un test que afirmaba que lanzaba.

> **Y una trampa que esta lista destapa.** El revelado del cierre de ronda muestra las manos a
> **todos**, y el nodo de la mano es el **mismo** ronda a ronda: vaciarlo no lo saca de las vistas de
> los clientes. Así que repartir tiene que **des-revelar** primero, o desde la segunda ronda cada mano
> nace pública para la mesa entera — el agujero del v1, reabierto por la puerta de atrás y sin que
> ningún test de la ronda 1 lo note. Es la única razón por la que el puerto de visibilidad tiene un
> `hide`.

### 3.2 Quién arranca

Regla en los tres modos: si algún jugador tiene la ficha doble-seis `[6|6]`, arranca esa persona; si nadie la tiene, arranca quien tenga "la ficha de mayor valor" (`determineFirstTurnPlayer`, 2P: `two-players/domino-room-state.ts:252-268`; 4P idéntico: `four-players/domino-room-state.ts:353-371`; torneo idéntico: `tournament-game.ts:176-192`).

**Hallazgo — la rama "sin doble-seis" no hace lo que dice.** `getHighestValueTile()` devuelve un objeto `Tile` (siempre verdadero) para cualquier mano no vacía (`player.state.ts:104-116`, igual en los tres modos). El `.find(player => player.hand.getHighestValueTile())` no compara valores entre jugadores: simplemente devuelve el primer jugador, en el orden de iteración del `MapSchema` `players` (= orden de `join`), cuya mano no esté vacía — lo cual, justo después de repartir, es cierto para todos. En la práctica: si nadie tiene doble-seis, arranca el primer jugador que se unió a la sala, no el dueño de la ficha de mayor valor. Es el mismo código copiado en los tres modos (`two-players/domino-room-state.ts:260-265`, `four-players/domino-room-state.ts:362-368`, `tournament-game.ts:184-189`), así que no es una divergencia entre modos — es un defecto compartido. Lo dejo anotado en §7 en vez de inventar cuál "debería" ser la regla.

### 3.3 El tablero y sus extremos

El tablero no se guarda como estructura aparte: se reconstruye a partir del historial de jugadas (`getBoardMoves()`, que filtra los movimientos que no son pase ni robo: `two-players/round.state.ts:161-165`, idéntico en `four-players/round.state.ts:165-169`).

`getBoardEnds()` (`two-players/round.state.ts:184-235`, idéntico en `four-players/round.state.ts:188-239`) recorre esos movimientos en orden y calcula `leftEnd`/`rightEnd`:
- Si no hay movimientos, el tablero está vacío (`null`).
- Cada ficha colocada trae un `lockedNumber` (el lado que se conectó con el extremo existente); el lado libre (`getOppositeNumber(lockedNumber)`) pasa a ser el nuevo extremo de ese lado.
- Las fichas dobles se colocan con `lockedNumber = -1` y no mueven ningún extremo (una ficha doble no "abre" un lado nuevo).

### 3.4 Jugada legal

`canPlayTile(tile, lockedNumber)` (`two-players/round.state.ts:243-287`, idéntico en `four-players/round.state.ts:247-291`) valida:
1. Si el tablero está vacío, la única exigencia es que `lockedNumber === -1` (primera ficha, cualquiera vale).
2. Si `lockedNumber !== -1`, debe ser uno de los dos lados de la ficha; si es `-1`, la ficha debe ser doble.
3. El número de conexión (`lockedNumber`, o `tile.left` si es doble) debe coincidir con `leftEnd` o `rightEnd`.

`checkIfTileCanBePlayed` (`two-players/round.state.ts:125-142`) revisa si una ficha suelta conecta con algún extremo, sin fijar todavía su `lockedNumber` — se usa para fichas recién robadas del pozo. `checkIfHandHasPlayableTiles` (`two-players/round.state.ts:149-151`) y `playerHasPlayableTiles` (`two-players/round.state.ts:294-311`) reutilizan esa misma noción de extremo para decidir si a un jugador "le sirve" alguna ficha de toda su mano.

### 3.5 Cuando no se puede jugar: robar y pasar

**2P y torneo** (con pozo): tras jugar una ficha, quien jugó revisa si el rival tiene ficha jugable con su mano actual (`checkIfHandHasPlayableTiles`, `two-players/commands/on-play-tile.ts:71`):
- Si el rival puede jugar, se le pasa el turno sin más (`nextTurn()`, `on-play-tile.ts:74`).
- Si el rival no puede jugar pero **el pozo tiene fichas**, igual se le pasa el turno (`on-play-tile.ts:77-78`) — quedará en sus manos robar cuando le toque.
- Si el rival no puede jugar y **el pozo está vacío**, se registra un pase por el rival y el turno vuelve a quien jugó (`on-play-tile.ts:80-83`).

Robar (`LOAD_TILE`, `two-players/commands/on-load-tile.ts:9-46`): saca una ficha del pozo, la agrega a la mano y revisa si es jugable (`checkIfTileCanBePlayed`, `on-load-tile.ts:35`). El detalle que importa no es de quién es el turno —siempre sigue siendo del mismo jugador— sino **qué le pasa al reloj**:
- **Si es jugable**: el bloque `if (!canBePlayed) { … }` se saltea entero, así que **no se llama a `changeTurn` y el plazo del turno NO se reinicia**: sigue corriendo desde antes de robar.
- **Si no es jugable y el pozo quedó vacío**: se anota un pase y el turno pasa al rival (`nextTurn()`).
- **Si no es jugable pero el pozo aún tiene fichas**: se llama `changeTurn(player.id)` (`on-load-tile.ts:41-43`), que **sí reinicia el plazo**, y el turno se mantiene en el mismo jugador para que robe de nuevo. El cliente debe seguir mandando `LOAD_TILE` hasta obtener una ficha jugable o agotar el pozo; el servidor no fuerza varios robos de una sola vez.

> **Asimetría a decidir para el v2.** Robar mal reinicia el reloj; robar bien no. Un jugador que roba
> seis fichas inservibles se lleva seis plazos completos, y uno que roba la ficha justa juega con el
> tiempo que le quedaba. No hay nada en el código que indique que sea deliberado —cae de qué rama
> llama a `changeTurn`—, así que va a §7 como decisión abierta en vez de darla por regla.

El torneo reutiliza exactamente esta lógica (`tournaments/game/commands/on-play-tile.ts:69-82`, `on-load-tile.ts:35-44`).

**4P** (sin pozo): si quien tiene el turno no puede jugar, no hay robo posible — se anota el pase (`addPassMove`) y se evalúa al siguiente jugador en la rotación circular, con una pausa de 2 s entre cada chequeo para que el pase se note en el cliente antes de seguir probando al siguiente (`checkNextPlayer`, `four-players/commands/on-play-tile.ts:97-132`).

### 3.6 Cierre por dominó

Si tras jugar una ficha la mano del jugador queda en 0, la ronda termina por "dominó" (`DominoWinType.STANDARD`):
- 2P/torneo: `two-players/commands/on-play-tile.ts:48-51`, `tournaments/game/commands/on-play-tile.ts:47-50`.
- 4P: gana el equipo del jugador que se quedó sin fichas, no solo esa persona (`four-players/commands/on-play-tile.ts:61-65`).

### 3.7 Cierre por tranca

`isGameBlocked` (2P/torneo, `two-players/round.state.ts:320-338`) declara tranca sólo si **ni con las fichas restantes del pozo** ninguno de los dos podría jugar — primero prueba con las manos actuales, y si nadie puede, prueba de nuevo agregando `remainingTiles` (el pozo) a cada mano hipotéticamente. Es la definición estricta: tranca real, no solo "nadie tiene jugada ahora mismo".

`isGameBlockedFourPlayers` (4P, `four-players/round.state.ts:350-360`) es más simple porque no hay pozo que agregar: declara tranca en cuanto ningún jugador de ningún equipo puede jugar con su mano actual.

**Hallazgo — duplicación con método muerto.** Cada uno de los dos archivos `round.state.ts` (2P y 4P son copias casi idénticas) declara **ambos** métodos, `isGameBlocked` y `isGameBlockedFourPlayers`, aunque cada modo sólo llama al que le corresponde: 2P usa `isGameBlocked` (`two-players/commands/on-play-tile.ts:59`) y nunca `isGameBlockedFourPlayers` (declarado igual en `two-players/round.state.ts:346-356` pero sin ningún caller); 4P usa `isGameBlockedFourPlayers` (`four-players/commands/on-play-tile.ts:76`) y nunca `isGameBlocked` (declarado igual en `four-players/round.state.ts:317-342`, sin caller). Es deuda de copiar-pegar entre los dos archivos, no una decisión de diseño.

### 3.8 Conteo

Al cerrar la ronda (por dominó o por tranca sin empate), quien ganó suma a su puntaje **todos los pips que quedaron en la mano del perdedor**:
- 2P/torneo: `winner.score += rival.hand.valueInHand()` (`two-players/domino-room-state.ts:331`, `tournament-game.ts:241`).
- 4P: **cada** jugador del equipo ganador suma individualmente la **suma de los pips de ambos jugadores del equipo perdedor** (`losingTeamTotalPoints`, `four-players/domino-room-state.ts:421-426`) — no se reparte, cada compañero recibe el total completo, lo que mantiene sus puntajes individuales sincronizados ronda a ronda (ver §2.2).

Empate por tranca (pips iguales): ver §7, decisión 3.

## 4. La partida

### 4.1 Secuencia de rondas

- 2P/torneo: quien arranca la siguiente ronda es el rival de quien arrancó la ronda anterior (`startNextRound`, `two-players/domino-room-state.ts:375-387`, `tournament-game.ts:276-286`) — alternancia estricta entre los dos jugadores.

  > **La regla del doble-seis (§3.2) vale SOLO para la ronda 1.** De la 2 en adelante no se vuelve a mirar la mano: manda la alternancia. Y eso obliga a que "quién abrió esta ronda" sea **estado**, no un dato de vuelo: una vez que el turno se movió, la mano de nadie dice quién abrió. El v1 lo guarda en `currentRoundStarterId` (`two-players/domino-room-state.ts:51`); el v2 lo guarda en `RoundState.starterId`. Sin ese campo, la única forma de decidir la ronda 2 es volver a correr el doble-seis — que es la regla equivocada.

- 4P: el arranque de ronda rota circularmente por `playerNumber` (`four-players/domino-room-state.ts:472-500`) — no es "el rival de quien arrancó", sino "el siguiente en sentido horario". Como los equipos están intercalados por `playerNumber` impar/par (§2.2), el efecto observable es el mismo: el equipo que arranca alterna cada ronda, aunque el mecanismo interno sea distinto (jugador siguiente en la rotación, no jugador rival directo).
- Si el jugador que debe arrancar la ronda en 4P es un bot, juega automáticamente al inicio de la ronda (`playBotTileAtRoundStart`, `four-players/domino-room-state.ts:496-499, 800-840`).

### 4.2 Fin de partida

La partida termina cuando alguien alcanza `pointsToWin` (comparación `>=`, no `>`):
- 2P: `player.score >= this.pointsToWin` (`two-players/domino-room-state.ts:426`).
- 4P: `this.getTeamScore(team) >= this.pointsToWin` (`four-players/domino-room-state.ts:509`).
- Torneo: `player.score >= this.pointsToWin` (`tournament-game.ts:313`).

El valor real de `pointsToWin` en cada modo — de dónde sale en tiempo de ejecución — se trata en §7, decisión 2.

### 4.3 Abandono y forfeit

- **2P**: cualquier abandono (`OnLeaveCommand`) o timeout de turno (`OnTimeoutCommand`) saca al jugador de `players` (`removePlayer`, `two-players/domino-room-state.ts:90-104`). Como sólo hay 2 jugadores, sacar a uno deja exactamente 1 — y eso dispara `finishGame` de inmediato a favor del que queda (`two-players/commands/on-leave.ts:40-42, 53-57`, `on-timeout.ts:38-40, 51-55`). No hay sustituto ni gracia adicional: cualquier desconexión que agote el timer termina la partida.
- **4P**: un abandono o timeout **no termina la partida automáticamente**. `OnLeaveCommand`/`OnTimeoutCommand` sacan al jugador y evalúan (`four-players/commands/on-leave.ts:40-72`, `on-timeout.ts:37-69`, ambos con la misma estructura):
  - Si el equipo del jugador que se fue queda **sin ningún humano** (`checkOnlyOneTeam`), se termina la partida a favor del equipo rival (forfeit inmediato).
  - Si ambos equipos siguen teniendo al menos un humano (`checkPlayersLeft`): si `enableBots` está activo **y** la partida ya era válida (todos habían revelado fichas) antes del abandono, se sustituye al jugador por un bot que hereda su mano, equipo y posición, y sigue jugando (`addBot`/`createBot`, `on-leave.ts:112-135`, `on-timeout.ts:109-132`). Si la partida **no** era válida todavía, se hace forfeit igual.
  - **Hallazgo — hueco no cubierto**: si `enableBots` es `false` y el abandono ocurre con la partida ya válida y ambos equipos con humanos, ninguna rama del código actúa: no se agrega bot ni se fuerza forfeit. El jugador queda en `quitPlayers` con su mano congelada (nunca se vuelve a jugar ni se descarta), y la rotación de turnos sigue sólo entre los jugadores restantes. Como `enableBots` por defecto es `true` para modos de 4 jugadores (`game-mode.schema.ts:66-70`), este hueco sólo se activa si un modo de juego se configura explícitamente con `enableBots: false`, algo que hoy no se ve forzado en ningún lado del código de creación de modos. Lo dejo señalado en vez de asumir qué "debería" pasar.
- **Torneo**: mismo patrón que 2P (expulsión + forfeit con 1 jugador restante, `tournaments/game/commands/on-leave.ts:38-46`, `on-timeout.ts:29-37`), más una capa exclusiva de torneo: cada abandono voluntario en partida iniciada, o cada timeout de turno, registra un "strike" contra ese jugador para todo el torneo (`TournamentPenaltyService.registerStrike`, `tournaments/penalty/tournament-penalty.service.ts:63-105`). El registro de strikes expira a las 24 h sin nuevas infracciones (`STRIKES_DECAY_SECONDS`, `tournament-penalty.service.ts:18`).

> **Hallazgo — la penalización tiene un off-by-one, y el comentario del propio archivo miente.**
> El comentario de `tournament-penalty.service.ts:4-8` dice que el 1º y el 2º strike son sólo
> advertencia y que la penalización arranca en el 3º. La aritmética real (`:51-56`) es otra:
>
> ```
> if (strikes < MIN_STRIKES_FOR_PENALTY) return 0        // MIN_STRIKES_FOR_PENALTY = 2
> const multiplier = strikes - MIN_STRIKES_FOR_PENALTY + 1
> return PENALTY_MINUTES_PER_STRIKE * multiplier * 60    // PENALTY_MINUTES_PER_STRIKE = 10
> ```
>
> Con `strikes = 2`: la guarda no corta (`2 < 2` es falso) y `multiplier = 1`, así que **el segundo
> strike ya penaliza 10 minutos**. La escalera real es 1→0 min, 2→10, 3→20, 4→30. Es un defecto del
> v1, no una regla; el motor de torneo del v2 tiene que decidir cuál de las dos escaleras implementa.

## 5. Los plazos

### 5.1 El turno

Los tres modos usan el mismo esquema de dos temporizadores encadenados, corriendo cada segundo (`clock.setInterval(…, 1000)`):
1. `turnTimeRemaining` arranca en 60 y baja de a 1 (2P: `domino-two-room.ts:411-424`; 4P: `domino-four-room.ts:380-393`; torneo: `tournaments/game/room.ts:332-345`).
2. Al llegar a 0, empieza a bajar `extraTimeRemaining` desde 30 (2P: `domino-two-room.ts:425-430`; 4P: `domino-four-room.ts:394-399`; torneo: `room.ts:346`).
3. Cuando `extraTimeRemaining` también llega a 0 (≈ 90 s totales desde que empezó el turno), se dispara `OnTimeoutCommand` (2P: `domino-two-room.ts:431-436`; 4P: `domino-four-room.ts:400-405`; torneo: `room.ts:348-351`).

**Los dos plazos se reinician enteros en cada turno**, porque `setTurnTimeouts` reescribe los tres campos del jugador y `changeTurn` lo llama en cada cambio de turno. La consecuencia: un jugador que agota los 90 s en diez turnos se lleva **300 s de gracia** a lo largo de la ronda, y no hay ningún costo por haberla usado antes. Ver §7, decisión 7 — en el v2 esto cambia.

Antes de eso, durante la fase de revelar fichas al empezar cada ronda hay un plazo aparte, `initialTilesTimeRemaining`, que arranca en 15 y dispara `OnTimeoutRevealCommand` si no todos revelaron a tiempo — mismo valor y misma estructura en los tres modos (2P: `domino-two-room.ts:768-780`; 4P: `domino-four-room.ts:669-681`; torneo: `room.ts:365-377`).

Adicionalmente, 2P tiene un tercer plazo propio de su mecánica de apuesta dinámica entre rondas (`actionResponseTimeRemaining`, 10 s, `domino-two-room.ts:450-465`) para responder a una propuesta de multiplicador (`OnProposeBetMultiplierCommand`/`OnRespondBetMultiplierCommand`, `two-players/commands/on-propose-bet-multiplier.ts`, `on-respond-bet-multiplier.ts`) — no existe en 4P ni en torneo (no hay esos comandos en sus carpetas). Esta mecánica es economía de apuestas, no una regla del juego de dominó en sí; la dejo fuera del alcance de este documento salvo mencionarla aquí y en el glosario.

### 5.2 Qué hace el sistema al vencer un plazo

Ver §7, decisión 1, para el detalle completo y la recomendación.

## 6. Divergencias entre modos

| Regla | 2P | 4P | Torneo | Quién gana en v2 y por qué |
|---|---|---|---|---|
| Pozo / robo de ficha | Sí, 14 fichas sobrantes; robo manual repetido vía `LOAD_TILE` (`two-players/commands/on-load-tile.ts`) | No existe — 4×7=28=todo el set, sin sobrante (`four-players/domino-room-state.ts:337-348`) | Igual que 2P (`tournaments/game/commands/on-load-tile.ts`) | El motor 2P del v2 necesita el pozo; el motor 4P no. No es una elección — depende de la aritmética 2×7 vs 4×7. Ambos motores del v2 deben modelarlo explícitamente, no asumir que uno es "variante" del otro. |
| Asignación de equipos (4P) | N/A | Aleatoria e intercalada por `playerNumber` al iniciar la partida, salvo revancha (`four-players/commands/on-ready.ts:70-134`) | N/A | **DECIDIDO: se mantiene el sorteo aleatorio** — es requerimiento de producto. Con una condición que el v1 no cumple: la permutación se deriva del `seed`, no de `Math.random()`, porque si no las parejas de una partida jugada no se pueden reconstruir y el replay no reproduce nada. Y detrás de una política parametrizable (`SHUFFLED` / `SEAT_ORDER`), para que cambiar a parejas asignadas sea configuración y no código. Costo asumido: dos cómplices caen de compañeros 1 de cada 3 veces, así que la defensa contra colusión recae entera sobre el veto de par y el cooldown. |
| Abandono / timeout de turno | Expulsión inmediata → forfeit si sólo queda 1 humano (`two-players/commands/on-leave.ts`, `on-timeout.ts`) | Sustitución por bot si `enableBots` y partida válida; forfeit sólo si un equipo queda sin humanos o la partida no era válida (`four-players/commands/on-leave.ts`, `on-timeout.ts`) | Igual que 2P + registro de "strike" acumulativo por torneo (`tournaments/penalty/tournament-penalty.service.ts`) | Ver §7 decisión 1 — recomiendo el modelo con verbo automático (jugar/robar/pasar) antes de expulsar, para 2P y 4P por igual. |
| `pointsToWin` — origen real | Config de `GameMode` en Mongo, leída al crear la sala (`domino-two-room.ts:114`) | Config de `GameMode` en Mongo (`domino-four-room.ts:119`) | Config de `scoringConfig.pointsToWin` del torneo, con fallback a 25 (`tournaments/game/room.ts:82`) | Ver §7 decisión 2 — en v2, un único config explícito por modo de juego, sin defaults implícitos en tres capas distintas. |
| Empate de ronda (tranca con pips iguales) | Nadie suma puntos; la ronda se descarta y se juega otra (`two-players/domino-room-state.ts:352-370`) | Idéntico: nadie suma puntos, misma estructura (`four-players/domino-room-state.ts:448-466`) | Idéntico a 2P (`tournament-game.ts:258-274`) | Sin divergencia real — los tres modos ya coinciden. Ver §7 decisión 3 para el detalle exacto. |
| Método "ronda bloqueada" duplicado | Declara `isGameBlocked` (usado) e `isGameBlockedFourPlayers` (muerto) en el mismo archivo (`two-players/round.state.ts`) | Declara `isGameBlockedFourPlayers` (usado) e `isGameBlocked` (muerto) en el mismo archivo (`four-players/round.state.ts`) | Reusa el `isGameBlocked` de 2P, sin el método muerto propio | En v2, cada motor declara sólo el método que usa. No es una regla de negocio, es deuda de copiar-pegar a limpiar. |
| Mecánica de apuesta dinámica entre rondas | Sí (`on-propose-bet-multiplier.ts`, `on-respond-bet-multiplier.ts`) | No existe | No existe | Fuera del alcance de las reglas del juego; si se porta a v2, es una decisión de producto aparte, no parte del motor base. |
| Bots | No existen (sin campos `enableBots`/`botIsPlaying` en el estado) | Sí, sustituyen jugadores ausentes (`enableBots`, `botIsPlaying`, `four-players/domino-room-state.ts:53,55`) | No existen | El motor 2P y el de torneo no necesitan modelar bots; el 4P sí. |

## 7. Decisiones tomadas al redactar

### Decisión 1 — Qué hace el sistema al vencer el turno ✅ DECIDIDO

> **Resuelto: se conserva el comportamiento del v1, y el v1 hace DOS cosas distintas según el modo.**
> Se descartó el modelo de truco de ejecutar el verbo del que calló.
>
> | Modo | Al vencer el plazo |
> |---|---|
> | **2P** y **torneo** | Se **retira** al jugador. Como quedan dos asientos, eso deja uno solo y la partida cae por **forfeit** a favor del que queda |
> | **4P** | Se retira al humano y **un bot ocupa su asiento**: hereda su mano, su equipo y su posición, y sigue jugando. La partida **continúa**. Solo hay forfeit si el equipo del ausente se queda sin ningún humano, o si la partida todavía no era válida |
>
> **El motor nunca juega por nadie en ninguno de los dos casos.** Lo que cambia no es el motor: es
> quién ocupa el asiento después. Ver abajo.

**Cómo se modela el bot en el v2, y por qué no vive en el motor**

El bot **no es una regla del dominó** — es quién conduce un asiento. Meterlo en el motor obligaría al
engine a saber que existen jugadores automáticos, y eso contamina las reglas con una decisión de
plataforma.

El reparto queda así, y cae exactamente sobre las capas que ya existen:

| Capa | Qué sabe | Qué hace |
|---|---|---|
| **Motor** (`core/`) | que un asiento dejó de tener jugador humano | retira al jugador y emite `ABANDON`. Nada más |
| **Anillo** (`network/`) | que en 4P, con bots habilitados y la partida ya válida, ese asiento se rellena | escucha `ABANDON`, engancha el bot por el `BotPort`, y emite `BOT_ATTACHED` |
| **Bot** (`features/bots/`) | las reglas, como cualquier cliente | manda comandos por el **mismo camino** que un humano |

Tres consecuencias que valen la pena:

1. **El bot pasa por las mismas validaciones que un jugador.** No hay una puerta trasera por la que
   pueda hacer una jugada ilegal, porque no tiene una ruta propia hacia el estado.
2. **El historial no necesita un campo nuevo.** El `ABANDON` marca el instante; todo lo que ese asiento
   haga a partir de ese `seq` lo hizo el bot. Para auditar una partida eso alcanza y sobra.
3. **El motor de 2P y el de 4P son el mismo.** La diferencia entera —forfeit o bot— vive en un listener
   del anillo, que es donde el v1 la tenía enterrada dentro de `OnTimeoutCommand`.

> **⚠ Queda un hueco del v1 que NO se replica, y hay que decidir con qué se reemplaza.** Si
> `enableBots` está en `false`, la partida ya es válida y ambos equipos conservan humanos,
> **ninguna rama del código del v1 actúa** (§4.3): el jugador queda congelado en `quitPlayers` con su
> mano intacta y la rotación de turnos sigue entre los que quedan. No es una regla, es un bug. Ver la
> decisión 6.

**Qué hace el código hoy:**
- **2P**: `OnTimeoutCommand` saca al jugador de `players` (`removePlayer`, `two-players/domino-room-state.ts:90-104`) apenas se agotan los 60 s + 30 s de gracia (`two-players/commands/on-timeout.ts:32`). Como sólo quedan 2 jugadores, la partida termina de inmediato a favor del que se queda (`on-timeout.ts:38-40, 51-55`). El sistema nunca juega, roba ni pasa en nombre del jugador ausente — sólo espera el plazo y expulsa.
- **4P**: mismo plazo (60 s + 30 s), pero `OnTimeoutCommand` (`four-players/commands/on-timeout.ts`) sólo expulsa sin sustituto si el equipo del ausente queda vacío de humanos, o si la partida aún no era válida. Si `enableBots` está activo y la partida ya era válida, sustituye al jugador por un bot que **sí** sigue jugando fichas automáticamente (`playBotTile`, `on-timeout.ts:139-189`) — el bot elige una ficha jugable con una heurística simple (mayor valor, `DominoUtils.chooseTile`, `domino.utils.ts:74-101`), no imita al jugador ausente.
- **Torneo**: igual que 2P (expulsión + forfeit con 1 jugador restante), más un "strike" acumulativo de penalización de torneo (`tournaments/game/commands/on-timeout.ts:27`, `tournaments/penalty/tournament-penalty.service.ts`).

**Las opciones:**
1. Mantener el modelo actual: expulsión tras 90 s de gracia, sin acción automática en nombre del jugador.
2. Adoptar el modelo de truco-backend-v2: el sistema ejecuta el verbo del que calló (juega una ficha legal si tiene alguna — o la única posible si sólo hay una —, si no puede jugar y hay pozo roba automáticamente, si no puede jugar y no hay pozo pasa) y sólo expulsa al jugador tras agotar un tiempo extra adicional dedicado a esa inacción repetida.
3. Híbrido: mantener la expulsión en 2P (donde cualquier abandono ya mata la partida por diseño — no hay a quién sustituir) pero adoptar el verbo automático en 4P, generalizando lo que hoy sólo existe para "sustituir con bot que juega solo" a también cubrir el caso de robar/pasar automático antes de convertir al jugador en bot.

**Mi recomendación**: opción 2 para ambos motores del v2. Justificación: el modelo actual de 2P termina la partida en la primera desconexión de cualquiera de los dos jugadores — no hay forma de que sobreviva a un timeout, por diseño (sólo hay 2 asientos). Eso maximiza cuántas partidas mueren por una desconexión momentánea (un semáforo en rojo, una app que se refresca) en vez de por abandono real. El modelo de "ejecutar el verbo automáticamente" ya existe parcialmente en 4P (el bot sustituto juega fichas solo) — llevarlo a 2P y hacerlo explícito en 4P (en vez de esperar 90 s completos sin hacer nada y recién ahí decidir bot-o-forfeit) alinea el comportamiento con el de truco-backend-v2 y reduce partidas muertas por causas ajenas al abandono voluntario. Pero esto es una decisión de producto — cuánto tiempo extra dar, si el auto-play cuenta como "jugada real" para estadísticas, si cambia el criterio de `isValid` — que debe confirmar el dueño del proyecto antes de escribir el motor nuevo.

### Decisión 2 — `pointsToWin` por defecto ✅ DECIDIDO

> **Resuelto: 25**, que es el que hoy corre de verdad. Se borran las otras tres apariciones muertas
> (15 en el estado, 10 en el DTO no invocado, 100 en el snapshot de 4P).

**Cuál está muerto:** el default de clase (15, declarado en `two-players/domino-room-state.ts:45` y `four-players/domino-room-state.ts:49`) **nunca sobrevive a una partida real**. Se sobreescribe sin condición al crear la sala, antes de que empiece cualquier juego: `this.state.pointsToWin = gameMode.pointsToWin` (`domino-two-room.ts:114`, `domino-four-room.ts:119`), leyendo el documento `GameMode` correspondiente desde Mongo.

**De dónde sale el número real:** de la colección `game_modes_domino`, campo `pointsToWin` de cada modo de juego (`src/storage/mongo/schemas/game-mode.schema.ts:4-17`). Ese documento se crea vía `POST /game-modes` (`src/game-modes/routes.ts:90-93`) que pasa `req.body` **sin validar con Zod** directo a `GameModeService.create()` (`src/game-modes/game-mode.service.ts:56-69`), que a su vez llama `GameMode.create({ uuid, ...data, ... })` — un passthrough a Mongoose. Si el admin no manda `pointsToWin` en el body, Mongoose aplica su propio default: **25** (`game-mode.schema.ts:51-55`).

**Hallazgo — hay un tercer número, también muerto:** existe un DTO de validación con Zod (`CreateGameModeSchema`/`UpdateGameModeSchema`, `src/game-modes/dto/game-mode.dto.ts:4-58`) cuyo default de `pointsToWin` es **10** (`game-mode.dto.ts:18-20`). Confirmé con `grep` que ese schema **nunca se invoca** (`.parse()`/`.safeParse()`) en ningún lugar del código — sólo se usan sus tipos inferidos (`CreateGameModeDto`/`UpdateGameModeDto`) como anotación de tipo en `routes.ts:6, 90, 108`. Es decir: la ruta HTTP no valida el body con ese schema, así que su default de 10 es código muerto que nunca corre.

Hay además una **cuarta** aparición del campo, en `src/storage/mongo/schemas/game-two-state.schema.ts:217` (default 15) y `game-four-state.schema.ts:129` (default 100) — pero esas son colecciones de *snapshot* del estado de la sala para persistencia/recuperación (`game_two_states`/`game_four_states`), no de configuración. Su default tampoco corre nunca en la práctica: el snapshot siempre se guarda con `this.state.pointsToWin` ya resuelto por la sala antes de llamar `saveRoomState()`.

**El número real, entonces:** depende de qué `pointsToWin` tenga guardado cada modo de juego en Mongo — no hay un único "el real", es por modo. Si un modo se crea sin especificarlo, el default operativo es **25** (el de Mongoose), no 15 ni 10.

**Torneo**: usa `tournament.scoringConfig.pointsToWin ?? 25` (`tournaments/game/room.ts:82`) — mismo patrón: viene de una config externa (el servicio de torneos, no está en este repo) con fallback a 25 si no se especifica.

**Las opciones:**
1. Adoptar 25 como default único de v2 (es el que ya gana en la práctica en 2P/4P vía Mongoose, y coincide con el fallback explícito del torneo).
2. Adoptar el que el dueño del producto realmente quiere usar como default de catálogo, y borrar las otras tres apariciones muertas (15 en el estado, 15 en el snapshot 2P, 100 en el snapshot 4P, 10 en el DTO no usado) para que no vuelvan a confundir a la próxima persona que lea el código.

**Mi recomendación**: opción 2, con el número que confirme el dueño del proyecto — pero señalo que **25 es el que hoy corre de verdad** cuando un modo no especifica el campo, así que si no hay una razón de negocio para cambiarlo, mantenerlo evita un cambio de comportamiento no solicitado. Lo marco pendiente porque "cuál debería ser" es decisión de producto, no algo que el código conteste.

### Decisión 3 — Empate de ronda ✅ DECIDIDO

> **Resuelto: se mantiene tal cual.** Nadie suma, la ronda se descarta y se juega otra. (aclaración, no ambigüedad)

Esta decisión es más una aclaración que una pregunta abierta: el código de 2P y 4P **coincide exactamente**, así que no hace falta elegir entre modos — pero como el plan pide tratarla como decisión explícita, la dejo documentada con el detalle exacto de qué pasa con los puntos.

**Qué pasa exactamente:** cuando el juego se traba (`isGameBlocked`/`isGameBlockedFourPlayers`) y las manos de ambos lados tienen la **misma cantidad de pips** (`getBlockWinner`, comparando `valueInHand()`):
- 2P: `two-players/domino-room-state.ts:396-417` — si `playerPoints === rivalPoints`, devuelve `{ winnerId: null, isTie: true }`.
- 4P: `four-players/domino-room-state.ts:521-541` — misma comparación pero sumando los pips de **ambos** jugadores de cada equipo; empate si los dos totales de equipo coinciden.

En ambos casos, `isTie: true` dispara `finishCurrentRoundTie()` (2P: `:352-370`; 4P: `:448-466`), que:
1. Marca la ronda como `roundEndReason = DominoWinType.DRAW` y `roundWinnerId`/`roundWinnerTeamId` vacío.
2. Le suma **0 puntos** a **todos** los jugadores (`addPointsEarned(player.id, 0)` para cada uno) — nadie gana ni pierde puntaje por esa ronda.
3. Guarda la ronda en el historial (`this.rounds.push(this.currentRound)`) — queda registrada como jugada, pero no afecta el marcador.
4. Espera 6 segundos y arranca la siguiente ronda (`startNextRound()`) — **sin** pasar por `checkWinningPlayer()`/`checkWinningTeam()`. Esto es consistente porque en un empate nadie sumó puntos, así que no hay forma de que alguien haya cruzado `pointsToWin` en esa ronda — pero es una omisión deliberada de la verificación, no sólo casualidad de los números.

**Torneo**: idéntico a 2P, mismo código (`tournament-game.ts:258-274`).

No hay opciones que recomendar aquí porque no hay divergencia que resolver — los tres modos ya están alineados. La marco como pendiente de confirmación solo para que el dueño del proyecto la lea y la avale explícitamente como la regla del v2, ya que el plan la pidió tratada como decisión.

### Decisión 4 — Qué le pasa al reloj cuando un jugador roba ✅ DECIDIDO

> **Resuelto: robar SIEMPRE reinicia el plazo del turno**, sea la ficha jugable o no. Se descartó
> replicar la asimetría del v1, que premiaba robar mal.

Salió de la auditoría del documento, no de la redacción inicial.

**Qué hace el código hoy** (`two-players/commands/on-load-tile.ts`, idéntico en torneo): robar una ficha **jugable** no toca el plazo del turno —el bloque que llama a `changeTurn` se saltea—, mientras que robar una ficha **inservible** con pozo restante llama `changeTurn(player.id)` y **reinicia el plazo entero**.

**La consecuencia:** un jugador que roba seis fichas inservibles se lleva seis plazos completos; uno que roba la ficha justa a la primera juega con el tiempo que le quedaba. Robar mal da más tiempo que robar bien.

**Las opciones:**
1. Replicar el v1 tal cual.
2. **Robar nunca reinicia el plazo.** El turno dura lo que dura, se robe o no.
3. Robar siempre lo reinicia, sea jugable o no.

**Mi recomendación:** opción 2. No hay nada en el código que sugiera que la asimetría sea deliberada —cae de qué rama llama a `changeTurn`—, y es la única de las tres que no se puede usar para estirar el turno. La 3 premia robar; la 1 premia robar mal.

### Decisión 5 — Primer turno sin doble-seis ✅ DECIDIDO

El v1 tiene un bug (§3.2): `.find(player => player.hand.getHighestValueTile())` no compara valores
entre jugadores, así que arranca el primero que se unió a la sala.

> **Resuelto: se arregla.** Arranca quien tenga el doble-seis; si nadie lo tiene, quien tenga la
> ficha de mayor valor, con **desempate determinista por asiento más bajo**. El desempate no es un
> detalle: sin él, dos repartos idénticos podrían arrancar distinto y el replay dejaría de reproducir.
>
> Consecuencia asumida: **el v2 no reproduce partidas del v1**, así que los fixtures golden del
> replay se generan del v2 y se revisan a ojo una vez.

### Decisión 6 — 4P con bots deshabilitados ✅ DECIDIDO

> **Resuelto: forfeit del equipo del que se fue.** Es lo que el v1 ya hace en sus otras dos ramas
> (equipo sin humanos, partida no válida), así que unifica el comportamiento en vez de sumar un cuarto
> caso. Y deja el flag con un significado honesto: *si no hay bots, un abandono cuesta la partida*.
> Se descartó seguir jugando a tres — eso no es un arreglo, es un modo de juego nuevo.

Sale del hueco de la decisión 1. Con `enableBots: false`, partida ya válida y ambos equipos con
humanos, el v1 **no hace nada**: ninguna rama actúa. El jugador queda en `quitPlayers` con su mano
congelada y los tres restantes siguen rotando turnos entre ellos. Es un bug, no una regla, así que no
se puede "conservar el v1" — hay que elegir con qué se reemplaza.

Hoy el hueco casi no se dispara: `enableBots` viene en `true` por defecto para modos de cuatro
jugadores (`game-mode.schema.ts:66-70`) y nada en el código de creación de modos lo pone en `false`.
Pero el campo existe y es configurable, así que la rama es alcanzable.

**Las opciones:**
1. **Forfeit del equipo del que se fue.** Es lo que el v1 ya hace en las otras dos ramas (equipo sin
   humanos, o partida no válida), así que unifica el comportamiento: sin bot que rellene, el equipo
   incompleto pierde.
2. **Attachear el bot igual, ignorando el flag.** Convierte `enableBots` en una mentira, pero ninguna
   partida muere por una desconexión.
3. **Seguir a tres jugadores.** Hay que inventar reglas que el dominó por parejas no tiene (qué pasa
   con la mano huérfana, cómo se cuenta la tranca, quién cobra sus pips). Es diseño nuevo.

**Mi recomendación:** opción 1. Es la única que no inventa reglas ni miente sobre la configuración, y
deja el flag con un significado honesto: *"si no hay bots, un abandono cuesta la partida"*. La 3 queda
descartada salvo que producto la pida explícitamente — no es un arreglo, es un modo de juego nuevo.

### Decisión 7 — El tiempo extra es una reserva de PARTIDA ✅ DECIDIDO

> **Resuelto: los 30 s de gracia pasan a ser un saldo para toda la partida, que solo decrece.** Se
> descartó replicar la gracia por turno del v1. Es un **cambio deliberado de regla**, no un port.

**Qué hace el v1** (§5.1): los 30 s se reinician en cada turno, porque `changeTurn` llama a
`setTurnTimeouts` y ése reescribe los tres campos. Un jugador que se cuelga sistemáticamente se lleva
30 s extra **por turno**, sin costo por haberlos usado antes.

**Qué hace el v2:** cada jugador arranca la partida con una reserva (30 s, `extraTimeReserveMs`), y
`PlayerState.extraTimeRemainingMs` **solo baja**. Al vencer el plazo normal del turno, si le queda
saldo el turno se estira con lo que le quede; si no, se lo retira (decisión 1, sin cambios). Lo que no
gastó de una extensión se le devuelve —decrece por lo **consumido**, no por haberla tocado—.

**Por qué:**
1. Es el modelo de truco (`PlayerState.extraTimeRemainingMs`, *"reserva de tiempo extra para TODA la
   partida; solo decrece"*), así que los dos juegos se sienten igual.
2. Un saldo con memoria **tiene que** ser estado. La gracia por turno era config y por eso el v1 podía
   olvidársela: el campo del estado es lo que la hace auditable.
3. El costo de colgarse deja de ser cero. Con la gracia por turno, el que abusa del reloj no paga
   nada; con la reserva, la segunda vez ya tiene menos colchón que su rival.

**Lo que hay que aceptar:** una partida larga puede terminar con un jugador sin reserva y otro con la
suya intacta, y ahí el primero juega con 60 s pelados contra 90. Eso es la regla, no un defecto — pero
es lo que producto tiene que avalar, porque cambia la experiencia respecto del v1.

**Y dos consecuencias para el cliente**, que son las únicas dos cosas que el front necesita para
dibujar el reloj y que no se derivan del `activeDeadline` a secas:

1. **`Turn.isConsumingExtendedTime`** — los dos tramos del plazo ocurren en la misma fase, así que sin
   este campo el cliente muestra una cuenta atrás sin saber si son los 60 s del turno o lo que queda de
   la reserva. Es un campo del estado porque un jugador que reconecta a mitad de un tramo extendido
   tiene que poder saberlo.
2. **`serverNow`, del `GET /config/:roomId`** — el `activeDeadline` es un instante en epoch del
   servidor, así que el front tiene que restarle "ahora"; con el reloj del dispositivo corrido, la
   cuenta atrás miente. El cliente calcula el offset una vez contra esa muestra. No es una regla del
   dominó, pero sin eso ninguna de las reglas de plazo de esta sección se ve bien en pantalla. Ver
   spec §7.4.

### Decisión 8 — Qué significa "partida válida", y quién cobra ✅ DECIDIDO

> **Resuelto: "válida" es una propiedad de la PARTIDA, no un booleano por jugador, y el cobro sale del
> motor.** Se descartó portar `PlayerState.isValid`.

`PlayerState.isValid` (`two-players/player.state.ts:126`, igual en 4P) es un booleano que se prende con
`markAsValid()` cuando el jugador revela fichas, y gobierna **dos cosas que no tienen nada que ver
entre sí**:

1. si un abandono en 4P termina en sustitución por bot o en forfeit inmediato (§4.3);
2. si se le cobra la entrada y si puede ganar puntos.

Eso es un eje mezclado con otro, y el nombre no dice ninguno de los dos. El reparto del v2:

| Qué | Dónde vive en el v2 |
|---|---|
| "la partida ya arrancó de verdad" | la **ventana de reparto** se cerró con alguien que levantó sus fichas (§3.1). Observable: `phase === "PLAYING"` de la ronda, o `players.some(p => p.hasSeenTiles)` |
| "a este jugador se le cobra" | `features/economy/`, colgado del `ROUND_RESOLVED`/`MATCH_RESOLVED`. El motor no sabe de plata |

**Y la ventana de reparto es lo que hace honesta esta definición.** Sin ella, "válida" era
`startedAt > 0` —o sea "la sala se llenó"—, que no dice nada sobre si alguien jugó. Con la ventana hay
un hecho observable y por jugador: `hasSeenTiles`. De ahí sale también el motivo de reembolso
`NEVER_PLAYED`, que es lo que distingue "nunca se llenó" de "se llenó, se repartió, y nadie apareció".

**Consecuencia sobre la decisión 6:** "la partida ya era válida" se lee del estado y no de un booleano
que alguien tuvo que acordarse de prender.

**Hallazgo relacionado, del mismo nombre:** `PlacedTile.isValid` (`piece.ts:71`) **es otra cosa y
además miente**. Se pone en `true` con solo pasarle una ficha al constructor (`piece.ts:78-81`), así
que una ficha **robada del pozo** —que nunca tocó el tablero— queda registrada con `isValid: true`
(`on-load-tile.ts:33`). No es una regla: es el tercer nombre para "acá hay una ficha", junto a
`isPassed` e `isLoaded`. En el v2 no existe ninguno de los tres (§9).

### Otros hallazgos que no encajan en las decisiones de arriba

- **§2.2**: el título "el orden de los asientos asigna los equipos" no corresponde al código — los equipos se sortean al azar al arrancar la partida (salvo revancha). Ver §2.2 para el detalle y la cita.
- **§3.2**: la lógica de "quién arranca sin doble-seis" no compara valores entre jugadores; en la práctica arranca el primer jugador por orden de `join`. Bug compartido por los tres modos, no una divergencia entre ellos.
- **§3.7**: `isGameBlocked` e `isGameBlockedFourPlayers` están duplicados sin uso en cada uno de los dos archivos `round.state.ts` — deuda de copiar-pegar, no diseño.
- **§4.3**: hueco en 4P cuando `enableBots = false` y hay un abandono a mitad de partida con ambos equipos todavía con humanos — ninguna rama del código reacciona (ni bot ni forfeit).
- **Torneo — `pointsPerWin` se pisa a sí mismo**: `tournament-game.ts:347` hace `this.pointsPerWin = this.matchQualityPoints`, reemplazando el valor configurado por un puntaje de "calidad de partida" calculado en `computeMatchQuality()` (`tournaments/scoring/tournament-scoring.service.ts:90-114`, basado en rondas jugadas y duración real vs. esperada, con un caso especial para partidas de 1 ronda). El puntaje que de verdad se publica al ganador es `this.matchQualityPoints` directamente (`tournament-game.ts:363`), no el campo `pointsPerWin` ya pisado — ese campo del estado queda como dato informativo/de sincronización al cliente, no como la fuente de verdad del puntaje otorgado. No es una regla del juego de dominó en sí (es puntaje de torneo, no de la partida), pero vale la pena que quien escriba el motor de torneo del v2 no asuma que `pointsPerWin` configurado es lo que efectivamente se otorga.

## 8. Glosario

- **Pip / valor de ficha**: suma de los dos números de una ficha (`Tile.getValue()`, `piece.ts:28-30`).
- **Doble**: ficha con `left === right` (`Tile.isDouble()`, `piece.ts:19-21`). Se coloca con `lockedNumber = -1` y no mueve los extremos del tablero.
- **`lockedNumber`**: el lado de una ficha ya colocada que quedó "contra" el tablero (conectado); el lado libre es el que puede recibir la próxima ficha.
- **Extremo (`leftEnd`/`rightEnd`)**: los dos números jugables en las puntas del tablero en un momento dado (`getBoardEnds()`).
- **Pozo**: fichas no repartidas al iniciar la ronda, disponibles para robar. Sólo existe en 2P y torneo (§1.2).
- **Robar / cargar ficha**: sacar una ficha del pozo cuando no se puede jugar (`LOAD_TILE`). No existe en 4P.
- **Tranca / juego bloqueado**: ningún jugador (o equipo) puede jugar, ni siquiera considerando el pozo restante. Cierra la ronda por `DominoWinType.BLOCK`.
- **Dominó (cierre de ronda)**: un jugador se queda sin fichas en mano. Cierra la ronda por `DominoWinType.STANDARD`.
- **`DominoWinType`**: motivo de cierre de ronda/partida — `standard` (dominó), `block` (tranca), `draw` (empate de tranca), `timeout` (venció el plazo de turno), `cancelled`, `notfunds` (fondos insuficientes al cobrar la entrada), `leave` (abandono) (`src/rooms/types/enum/end-round.ts:1-9`).
- **`RoomStatus`**: estado de la sala — `matching` (esperando jugadores), `enqueued` (sala llena, esperando que todos confirmen `READY`), `started`, `finished`, `canceled` (`src/rooms/types/enum/room-status.ts:1-7`).
- **`pointsToWin`**: puntaje que gana la partida (no la ronda). Ver §7 decisión 2 para su origen real.
- **Capitán de equipo (4P)**: jugador con `playerNumber` 1 o 2, cuyo `score` se usa como proxy del puntaje del equipo (`getTeamScore`).
- **Bot (4P)**: sustituto automático de un jugador humano ausente; hereda su mano, equipo y posición; elige jugada con una heurística simple de "mayor valor" (`DominoUtils.chooseTile`). No existe en 2P ni en torneo.
- **Strike / penalización de torneo**: contador de abandonos/timeouts de un jugador dentro de un torneo. La escalera real es 1→0 min, 2→10, 3→20, 4→30 (`TournamentPenaltyService`) — **no** la que dice el comentario del archivo; ver el hallazgo en §4.3. Es una capa exclusiva de torneo, no una regla del juego de dominó.
- **Propuesta de multiplicador de apuesta**: mecánica exclusiva de 2P que permite proponer subir el monto en juego entre rondas (`OnProposeBetMultiplierCommand`/`OnRespondBetMultiplierCommand`). Fuera del alcance de este documento de reglas de dominó.
- **Reserva de tiempo extra (v2)**: saldo de tiempo por partida que solo decrece, y que estira el turno cuando el plazo normal vence. Reemplaza la gracia por turno del v1 (§7, decisión 7).
- **Ventana de reparto**: los 15 s del arranque en los que cada jugador tiene que levantar sus fichas (`REVEAL_TILES`) para que la mano empiece. El plazo que controla a todos a la vez, y el que impide mirar el reparto y salirse gratis (§3.1).
- **Levantar las fichas**: hacer pública tu propia mano **para vos**, y quedar marcado con `hasSeenTiles`. No le muestra nada a nadie más.
- **Abrir la ronda / `starterId`**: quién juega la primera ficha de una ronda. La ronda 1 la abre el doble-seis; las siguientes alternan (§4.1).

## 9. El historial de jugadas

Esta sección no describe el v1: **corrige** cómo el v1 lo modela. Es la parte que más incomodó en
producción, y el defecto no es de implementación sino de forma.

### 9.1 Qué hace mal el v1

`HistoryMove` (`piece.ts:113-124`) es **un solo tipo de fila para tres actos distintos**, discriminado
por dos booleanos:

```ts
@type(PlacedTile) placedTile = new PlacedTile()
@type('boolean')  isPassed  = false
@type('boolean')  isLoaded  = false
```

Cinco defectos concretos:

| # | Defecto | Evidencia |
|---|---|---|
| 1 | **2 booleanos = 4 combinaciones, 3 legales.** `isPassed && isLoaded` es representable y no significa nada | `piece.ts:118-119` |
| 2 | **Tercera codificación del mismo hecho.** `PlacedTile.isValid` ("acá hay ficha") + `PlacedTile.isLoaded` (duplica el del `HistoryMove`) | `piece.ts:71-72`, seteado en `:80` |
| 3 | **`isValid` miente**: una ficha robada, que nunca tocó el tablero, queda `isValid: true` | `piece.ts:78-81` vs `on-load-tile.ts:33` |
| 4 | **`lockedNumber = -1` significa tres cosas**: doble, primera ficha, y relleno de un movimiento que no colocó nada | §3.3 y `on-load-tile.ts:33` |
| 5 | **El tablero no existe: es un `filter` sobre el log.** `getBoardMoves()` reconstruye la cadena filtrando por los booleanos | §3.3, `round.state.ts:161-165` |

Y el que no es de modelado sino de integridad: `historyMoves` es `@type([HistoryMove])`
(`round.state.ts:35`), o sea **sincronizado a todos**, y un movimiento de carga guarda la ficha robada
con su cara real (`on-load-tile.ts:33`). **Cada ficha que robás se le difunde al rival en el patch.**
Los booleanos no eran solo incómodos: eran el vehículo de una fuga.

### 9.2 El catálogo del v2, cerrado

Una entrada del historial se discrimina por `type`, cuyo dominio es **cerrado** y verificado por el
compilador (`keyof CommandPayloads | NetworkMatchEvent["type"]`). No hay booleanos, así que no hay
combinación ilegal que representar.

| `type` | `kind` | `source` | `payload` | Existe porque |
|---|---|---|---|---|
| `PLAY_TILE` | COMMAND | PLAYER | `{ playerId, left, right, side }` | el acto. El `side` lo manda el cliente; el número de engarce **no** —lo deriva el servidor— |
| `DRAW_TILE` | COMMAND | PLAYER | `{ playerId }` | qué ficha salió es reconstruible del `seed` (que vive en `match_meta`), así que no va en el payload |
| `PASS` | COMMAND | PLAYER | `{ playerId }` | el acto |
| `REVEAL_TILES` | COMMAND | PLAYER | `{ playerId }` | levantó sus fichas en la ventana de reparto (§3.1). Es la prueba de presencia, y para un reclamo de "me sacaron sin avisar" es la primera línea que se mira |
| `ABANDON` | COMMAND | PLAYER | `{ playerId }` | se fue por su voluntad |
| `ABANDON` | EVENT | SYSTEM | `{ playerId }` | **lo retiró el reloj.** Mismo nombre, distinto `source`: para un reclamo, esa es toda la diferencia |
| `DEADLINE_EXPIRED` | EVENT | SYSTEM | `{ kind }` | explica el hueco donde el reloj decidió |
| `ROUND_RESOLVED` | EVENT | SYSTEM | `{ roundNumber, winnerId, winnerTeamId, points, reason }` | consecuencia computada: no se reconstruye del comando |
| `MATCH_RESOLVED` | EVENT | SYSTEM | `{ winnerTeamId, reason }` | hito terminal. Se emite al **entrar** a la pausa de cierre, no al vencerla — el pago cuelga de acá |

**Fuera del historial**, a propósito: las jugadas **rechazadas** (rastro antifraude → va al log), el
`seed`, y cualquier volcado del estado.

**Agregar un caso es agregar una fila a esta tabla**, no un flag a una fila existente. Eso es todo lo
que hay que recordar del §9.1.

## 10. Los tres consumidores, y qué lee cada uno

El v1 usó **una sola lista** para tres roles, y de ahí salieron los booleanos: `historyMoves` era a la
vez la fuente del tablero, el feed de la UI y el registro de auditoría. Tres consumidores con
necesidades distintas sobre un tipo, y cada uno filtrando distinto.

| Consumidor | De dónde lee en el v2 | Qué NO es |
|---|---|---|
| **El tablero** | `RoundState.board.tiles` — solo fichas jugadas, sin filtro | no es un `filter` sobre un log |
| **El cliente** | los patches del estado sincronizado | no lee el historial: el historial **no** se sincroniza |
| **Auditoría / replay / soporte** | Mongo, append-only, por `matchId` + `seq` | no está en el `Schema` |

De esta tabla salen dos preguntas que resuelven solas casi todo lo demás:

1. **"¿Va al historial?"** → ¿es un acto o un hecho que no se reconstruye del comando ni del estado?
2. **"¿Va al estado?"** → ¿un cliente que **reconecta a mitad de partida** necesita saberlo?

Son criterios distintos y algo puede necesitar los dos. Por la segunda pregunta el estado lleva
`Turn.consecutivePasses` (pasar no deja huella en el tablero ni en el pozo, así que el contador **es**
su huella), `Turn.isConsumingExtendedTime` y `PlayerState.connected`. Por la primera, ninguno de los
tres emite evento.

Y la regla que cierra la puerta por la que el v1 se fue: **el historial no es del cliente.** La próxima
vez que haga falta "que el front sepa X", la respuesta es un campo de estado o un evento difundido —
nunca un booleano colgado de una entrada del historial.
