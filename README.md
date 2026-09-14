# domino-backend-v2

Backend de dominó multijugador sobre Colyseus 0.18. Las salas viven en el proceso; lo único
que persiste es el historial de cada partida, en Mongo, para la consola de soporte.

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

`MONGO_URI` **no la pongas en el `.env`**: la fija el compose apuntando al servicio
(`mongodb://mongo:27017/domino`). Lo que sí acepta el `.env` son dos variables que solo
entiende el compose (no están en `.env.example`, que documenta a `src/env.ts`):
`DOMINO_PORT` y `MONGO_PORT`, los puertos del **host**, por si ya hay algo escuchando en el
2567 o en el 27017 — pasa seguido si el mismo operador corre truco al lado.

Para mirar lo que quedó grabado:

```bash
docker compose exec mongo mongosh domino --eval 'db.match_history.find().limit(1)'
curl -H "X-Internal-Key: <la del .env>" http://localhost:2567/internal/matches/<matchId>/history
```

## Los tests

**No necesitan Docker ni Mongo.** `vitest.setup.ts` **borra** `MONGO_URI` del entorno antes
de que corra nada: sin la variable, el historial es el de memoria, y la suite no depende de
ningún servicio externo. Que eso sea una propiedad del repo y no del shell de quien lo corre
es la razón de esa línea — si la tenés exportada porque corrés otro proyecto al lado, la
suite igual no la mira.

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
