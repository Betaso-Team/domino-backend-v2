# Prototipo de matchmaking

El plan está en `PLAN.md` y en `plan.html`.

## Levantarlo

```bash
docker compose up --build
```

- **Jugador:** http://localhost:8080
- **Panel de admin:** http://localhost:8080/admin

## Qué mirar

1. Abrí el panel y agregá `+3 buscando`. El matchmaker los empareja de a dos y aparecen salas.
2. Abrí la página de jugador en dos pestañas con nombres distintos y dale a Buscar partida en
   las dos: las dos muestran la misma sala.
3. Con un bot quieto en la pool, dale a `buscar` desde el panel: se empareja con quien esté
   esperando.

En la consola:

```bash
docker compose logs -f matchmaker   # emparejo a ana con beto -> r-7f3a
docker compose logs -f jueguito     # sala r-7f3a lista: ana, beto
```

Y el booleano, a mano:

```bash
docker exec -it matchmaking-mvp-redis-orquestador-1 redis-cli HGETALL orq:usuarios
```

## Para probar con amigos

Están todos en la misma red: pasales `http://<tu-ip>:8080`. El puerto 8090 del jueguito también
tiene que estar alcanzable — la página arma la URL del juego con el mismo hostname por el que
entraste.

## Apagarlo

```bash
docker compose down
```
