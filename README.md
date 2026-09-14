# domino-backend-v2

Backend de dominó multijugador sobre Colyseus 0.18. Las salas se reparten entre los procesos
del clúster, que se ven entre sí por Redis; lo único que persiste es el historial de cada
partida, en Mongo, para la consola de soporte.

Si venís a trabajar sobre el código, lo que tenés que leer es `AGENTS.md`.

## Levantarlo con Docker

```bash
cp .env.example .env
# editá el .env: JWT_SECRET e INTERNAL_API_KEY, mínimo 16 caracteres cada una
docker compose up --build
```

`JWT_SECRET` es **obligatoria**: sin ella el proceso no arranca, a propósito.
`INTERNAL_API_KEY` no lo es, pero sin ella `/internal/matches/:matchId/history` **no se
registra** y responde 404 — es fail closed, y es el 404 que más se investiga al pedo.

`MONGO_URI` y `REDIS_URL` **no las pongas en el `.env`**: las fija el compose apuntando a los
servicios (`mongodb://mongo:27017/domino` y `redis://redis:6379/0`). Lo que sí acepta el
`.env` son tres variables que solo entiende el compose (no están en `.env.example`, que
documenta a `src/env.ts`): `DOMINO_PORT`, `MONGO_PORT` y `REDIS_PORT`, los puertos del
**host**, por si ya hay algo escuchando — pasa seguido si el mismo operador corre truco al
lado.

## Varias instancias

La presencia de `REDIS_URL` es lo que hace que varios procesos sean **un** servidor: comparten
el registro de salas de Colyseus, el presence y el registro de partidas vivas. Sin ella cada
proceso es un clúster de uno — correcto con una instancia, y roto en silencio con dos:
`GET /config/:roomId` devuelve 404 para cualquier sala del otro proceso y `joinById` no la
encuentra.

Con varias instancias hace falta además `SERVER_ADDRESS` (el host, sin puerto): cada proceso
anuncia `SERVER_ADDRESS/PORT` en la reserva de asiento para que el jugador se conecte al que
hospeda **su** sala. El puerto va como path porque es el esquema que el proxy de v1 ya rutea.

Para mirar lo que quedó grabado:

```bash
docker compose exec mongo mongosh domino --eval 'db.match_history.find().limit(1)'
curl -H "X-Internal-Key: <la del .env>" http://localhost:2567/internal/matches/<matchId>/history
```

## Los tests

**No necesitan Docker, ni Mongo, ni Redis.** `vitest.setup.ts` **borra** `MONGO_URI` y
`REDIS_URL` del entorno antes de que corra nada: sin ellas el historial es el de memoria y
Colyseus usa su driver y su presence locales, así que la suite no depende de ningún servicio
externo. Que eso sea una propiedad del repo y no del shell de quien lo corre es la razón de
esas dos líneas — si las tenés exportadas porque corrés otro proyecto al lado, la suite igual
no las mira.

```bash
npm ci
npm test
```

## El gate

```bash
npm run typecheck   # tsc --noEmit  <- ESTE es el gate, no el verde de vitest
npm test            # vitest run
npm run lint        # biome check src
npm run format      # biome format --write src, antes de commitear
```

Vitest transpila con esbuild, que borra los tipos sin chequearlos: una suite verde no dice
nada sobre si compila. El porqué largo está en `AGENTS.md`.
