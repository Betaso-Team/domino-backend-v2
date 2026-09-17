# Prototipo: delegar el matchmaking

**Lo que queremos ver:** el usuario está conectado al orquestador, le da clic a "Buscar
partida", y el orquestador **no busca nada** — solo marca un booleano en Redis. Quien busca es
otro servicio.

Levantamos una instancia de cada cosa. Pero no todas están pensadas para lo mismo.

---

## Quién escala y quién no

Esto no es un detalle de despliegue, decide cómo se escribe el código.

| Pieza | ¿Escala? | Por qué |
| --- | --- | --- |
| `back-orquestador` | **sí** | por eso ningún dato del jugador puede vivir en su memoria |
| `redis-orquestador` | **compartido** | es donde viven los jugadores; es lo que hace que varios orquestadores sean **uno solo** |
| `matchmaker` | **no, es uno** | ve la pool entera, y eso es lo que le permite usar el algoritmo que sea |
| `jueguito-backend` | sí, pero no acá | cada sala es independiente; no es parte de la pregunta |

**Que el matchmaker sea uno solo es una decisión, no una limitación.** Si hubiera dos, cada uno
vería un pedazo de la pool y tendría que conformarse con emparejar lo que le tocó. Uno solo ve a
todos los que están buscando al mismo tiempo, y con eso puede hacer lo que quiera: por tiempo de
espera, por nivel, por apuesta, por región, o todo junto.

**Que el orquestador escale es lo que obliga a que el estado viva en Redis.** Si el jugador
existiera solo en la memoria del proceso al que se conectó, el segundo orquestador no sabría que
existe. Por eso la lista de quién está conectado y quién está buscando está en Redis desde el
primer día, aunque hoy haya un solo proceso leyéndola.

---

## Las cinco piezas

```
  cliente-front ──ws──► back-orquestador ──────► redis-orquestador
        │                      ▲                       ▲    │
        │                      │                       │    │
        │                      │  "ya los emparejé"    │    │  lee quién
        │                      └───────── matchmaker ──┘    │  tiene buscando=true
        │                                    │              │
        │                                    └──────────────┘
        │                                    │
        └──────────ws──────► jueguito-backend ◄── "creame una sala"
```

| Pieza | Puerto | Qué hace |
| --- | --- | --- |
| `cliente-front` | — | página estática que sirve el orquestador |
| `back-orquestador` | 8080 | tiene el socket del usuario. **No empareja.** |
| `redis-orquestador` | 6380 | la lista de usuarios y su booleano |
| `matchmaker` | — | lee el booleano, arma parejas, avisa |
| `jueguito-backend` | 8090 | crea la sala y recibe a los dos jugadores |

---

## El booleano en Redis

Sí se puede, y es lo más simple que hay: **un solo hash**.

```
HSET orq:usuarios <userId> '{"nombre":"ana","nivel":"basico","buscando":false}'
```

El matchmaker lee todo de un saque con `HGETALL orq:usuarios` y filtra los que tienen
`buscando: true`. Sin scans, sin colas, sin nada raro.

| Llave | Qué es |
| --- | --- |
| `orq:usuarios` | hash: `userId → {nombre, nivel, buscando, desde}` |
| `orq:matches` | canal pub/sub: por ahí el matchmaker avisa |
| `orq:tickets` | hash: `ticket → {userId, salaId}` |

---

## El flujo, paso por paso

1. El cliente abre WebSocket contra el orquestador.
   → `HSET orq:usuarios <id> {nombre, buscando: false}`

2. El usuario da clic en **Buscar partida**.
   → el orquestador hace `HSET orq:usuarios <id> {..., buscando: true, desde: ahora}`
   → **y listo, ahí termina su trabajo.** Esto es la delegación.

3. El matchmaker, cada 1 segundo:
   → `HGETALL orq:usuarios`
   → se queda con los que tienen `buscando: true`
   → llama a `emparejar(candidatos, ahora)`, que aplica la regla de categorías

4. Por cada pareja que salió:
   → les pone `buscando: false` **antes que nada**, para que la vuelta siguiente no los reagarre
   → `POST jueguito:8090/salas` con los dos jugadores → le devuelve un `salaId`
   → guarda un ticket por jugador en `orq:tickets`
   → `PUBLISH orq:matches {salaId, jugadores, tickets}`

5. **Todos** los orquestadores están suscritos a `orq:matches`:
   → cada uno mira si tiene alguno de esos dos sockets
   → el que lo tiene manda `{t: "emparejado", salaId, url, ticket}`
   → el que no, ignora el mensaje

6. El cliente abre un **segundo** WebSocket contra el jueguito con su ticket.
   → el juego valida el ticket, lo mete en la sala
   → cuando están los dos, imprime en consola `sala r-7f3a lista: ana, beto`

Ese log es el resultado del prototipo.

Y cuando alguien cierra la pestaña: el orquestador hace `HDEL orq:usuarios <id>` y desaparece
de la lista.

**El paso 5 es pub/sub y no una llamada HTTP al orquestador por una razón concreta:** el
matchmaker no sabe —ni tiene por qué saber— a cuál de los orquestadores se conectó cada jugador.
Publica una vez y el que tenga el socket se da por aludido. Hoy con un orquestador se ve igual
que una llamada directa; con tres, sigue funcionando sin tocar nada.

---

## Las categorías y la espera

Tres categorías: **básico, medio, avanzado**. La regla no es una tabla de excepciones, es una
distancia:

| Distancia entre categorías | Quiénes | Espera mínima |
| --- | --- | --- |
| 0 | básico+básico, medio+medio, avanzado+avanzado | **al instante** |
| 1 | básico+medio, medio+avanzado | **5 s** |
| 2 | básico+avanzado | **10 s** |

Dos decisiones que están en el código y conviene tener presentes:

- **Cuenta el que más esperó de los dos**, no los dos. Si un básico lleva 6 s colgado y entra un
  medio recién llegado, se emparejan: el que estaba esperando es quien ensancha su búsqueda. Con
  la regla al revés, el recién llegado obligaría al otro a seguir esperando.
- **Prefiere siempre la distancia menor.** Aunque ya tengas derecho a cruzar de categoría, si
  aparece alguien de la tuya, va con ese. Verificado: un básico con 6 s de espera y un avanzado
  al lado esperando desde el mismo momento; entra un segundo básico y los dos básicos se
  emparejan al instante, el avanzado sigue en cola.

## La función que importa

Todo el prototipo existe para que esta función viva en el matchmaker y en ningún otro lado:

```js
function emparejar(candidatos, ahora) {
  // candidatos = [{userId, nombre, nivel, desde}, ...]  ← la pool entera
  // devuelve   = [{jugadores: [a, b], distancia, espera}, ...]
}
```

Cambiar la regla es cambiar dos constantes de este archivo:

```js
const NIVELES = ['basico', 'medio', 'avanzado']
const ESPERA_POR_DISTANCIA = [0, 5000, 10000]
```

Agregar una cuarta categoría es agregar un elemento a cada arreglo. Ni el orquestador ni el
front se enteran.

Le entra la pool completa porque el matchmaker es uno. Ahí está el valor de que no escale.

---

## Los archivos

```
explorations/matchmaking-mvp/
├── compose.yaml
├── Dockerfile
├── package.json
├── orquestador.js     el orquestador y nada más
├── panel.js           el admin y la demo: no es el orquestador
├── matchmaker.js
├── juego.js
├── public/index.html  jugador
└── public/admin.html  panel
```

Dependencias: `ws` e `ioredis`.

`panel.js` está aparte a propósito. Ahí viven las rutas `/admin/*`, los bots y el envío de la
pool a cada jugador —cosas de la demo, no del producto: un orquestador de verdad no le manda la
lista entera de quién está buscando a cada cliente—. Así `orquestador.js` se lee como lo que el
orquestador realmente hace: sostener sockets, marcar el booleano y repartir el aviso del match.

---

## La página

```
┌────────────────────────────────────┐
│  tu nombre  [ Ana          ]       │
│                                    │
│       [  BUSCAR PARTIDA  ]         │
│                                    │
│  estado     buscando · 00:07       │
│  sala       —                      │
│                                    │
│  ── BUSCANDO AHORA ──────────      │
│  beto    00:12                     │
│  caro    00:03                     │
└────────────────────────────────────┘
```

La lista de "buscando ahora" sale del mismo hash y la ven todos. Sirve para probar con amigos:
cada uno abre `http://<tu-ip>:8080`, todos se ven esperando, y cuando salta la pareja los dos
ven el mismo `salaId`.

---

## Docker

```yaml
services:
  redis-orquestador:
    image: redis:7-alpine
    ports: ["127.0.0.1:6380:6379"]

  back-orquestador:
    build: .
    command: node orquestador.js
    environment: [PORT=8080, REDIS_URL=redis://redis-orquestador:6379]
    ports: ["8080:8080"]

  matchmaker:
    build: .
    command: node matchmaker.js
    environment: [REDIS_URL=redis://redis-orquestador:6379, JUEGO_URL=http://jueguito:8090]

  jueguito:
    build: .
    command: node juego.js
    environment: [PORT=8090, REDIS_URL=redis://redis-orquestador:6379, PUBLIC_URL=ws://localhost:8090]
    ports: ["8090:8090"]
```

Un solo `Dockerfile` (`node:22-alpine`, `npm install`, copiar); lo que cambia es el `command`.
Redis en 6380 para no chocar con nada del repo.

El día que quieras ver dos orquestadores, es copiar el bloque de `back-orquestador` cambiando el
puerto. No hay que tocar código. Pero no es parte de este prototipo.

---

## Orden de construcción

1. **Redis + orquestador + página.** Entrás, das clic en Buscar partida, y lo comprobás con
   `redis-cli -p 6380 HGETALL orq:usuarios`: ahí está tu `buscando: true`. El orquestador no
   hizo nada más. **Acá ya se ve la delegación.**

2. **matchmaker.** Abrís dos pestañas, las dos dan clic, y en la consola del matchmaker aparece
   `emparejo a ana con beto`. Todavía sin juego.

3. **jueguito.** Las dos pestañas muestran el mismo `salaId` y el juego imprime la sala lista.
   Prototipo terminado.

```bash
cd explorations/matchmaking-mvp
docker compose up --build
# http://localhost:8080 en dos pestañas
```

---

## Para después, no ahora

- **TTL en los usuarios.** Si el orquestador se cae de golpe, deja entradas viejas en el hash.
  Se arregla con un plazo y un latido, pero con la pestaña abierta no molesta.
- **Segundo orquestador.** El código ya está escrito para eso —estado en Redis, aviso por
  pub/sub—; solo falta levantarlo y comprobarlo.
- **Segundo matchmaker.** No va a pasar: es uno por diseño.

---

JavaScript plano, un archivo por servicio, sin capas, sin tests y sin comentarios. Código para
tirar.
