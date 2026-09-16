# Lobby operativo y montos públicos

## Alcance

- Recuperar el contrato de estado del lobby v1: `totalPlayers`, `playersInLobby`,
  `gameModesCount`, `isUnderMaintenance` y `maintenanceMessage`.
- Mantener el estado de mantenimiento en el almacén compartido y permitir cambiarlo mediante una
  ruta interna autenticada, sin desplegar.
- Rechazar la creación de nuevas mesas durante mantenimiento sin interrumpir las que ya existen.
- Publicar en `GET /config/:roomId` los nombres históricos `entryFee` y `prize`. ⚠ ~~Sus valores
  siguen siendo enteros UC con dos decimales implícitos; la conversión de presentación pertenece al
  front.~~ **Supersedido** por
  [`2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design.md`](../specs/2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design.md):
  producción v1 nunca usó esa escala —`entryFee: 10` es **10 UC**—, así que los valores son números
  finitos no negativos y el front NO convierte nada. Los NOMBRES que este incremento recuperó son
  los correctos y no cambiaron; lo que cambió es la unidad que llevan adentro.

No entra matchmaking ni catálogo de mesas: todavía no existen en v2 y no hacen falta para recuperar
este contrato del front.

## Tareas

- [x] **Tarea 0 — Publicar el punto de continuidad.** Añadir este incremento a `AGENTS.md`.
- [x] **Tarea 1 — Montos públicos.** Escribir primero el test rojo del DTO y exponer `entryFee` y
  `prize` desde el snapshot inmutable, sin publicar tasa, moneda ni identidad.
- [x] **Tarea 2 — Estado y contadores del lobby.** Escribir primero el E2E rojo; añadir el schema,
  registrar `lobby`, autenticarlo y contar conexiones por `gameModeId` usando el listing compartido.
- [x] **Tarea 3 — Mantenimiento operativo.** Escribir primero los tests rojos de persistencia, ruta
  interna y rechazo de mesas; implementar el estado compartido y su actualización sin deploy.
- [x] **Tarea 4 — Cierre.** Actualizar documentación, reindexar el grafo y ejecutar `typecheck`, suite,
  formato/lint, build y depcruise.

## Criterio de cierre

- Un cliente de `lobby` recibe el mismo árbol mínimo que consumía el front v1.
- Los contadores incluyen todas las salas `domino` visibles por el driver del clúster.
- Un `POST /internal/lobby/maintenance` autenticado actualiza los lobbies y sobrevive a su recreación.
- Durante mantenimiento no se crean mesas nuevas; una mesa ya creada no se destruye.
- `/config/:roomId` responde `entryFee` y `prize`, nunca los nombres internos `*UcMinor`.
