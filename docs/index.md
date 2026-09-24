---
layout: home

hero:
  name: "Dominó Betaso"
  text: "Documentación técnica"
  tagline: Motor · salas Colyseus · catálogo · persistencia · operación
  actions:
    - theme: brand
      text: Entender la arquitectura
      link: /arquitectura
    - theme: alt
      text: Ver API y mensajes
      link: /api-y-mensajes

features:
  - icon: "🁣"
    title: "Partida y reglas"
    details: "Cómo nacen las mesas, qué estado sincronizan y cómo el motor decide fichas, turnos, tranca, puntaje y aumento de apuesta."
    link: /arquitectura#una-partida-de-principio-a-fin
    linkText: Seguir una partida

  - icon: "⚙️"
    title: "Arquitectura"
    details: "Separación entre reglas puras, motor mutante, red, transportes y composition roots. Incluye diagramas del sistema y del camino de un comando."
    link: /arquitectura
    linkText: Ver arquitectura

  - icon: "🔌"
    title: "Contratos externos"
    details: "Rutas HTTP, mensajes WebSocket, autenticación, estado del lobby y eventos que salen hacia la plataforma."
    link: /api-y-mensajes
    linkText: Ver contratos

  - icon: "🗄️"
    title: "Datos y resiliencia"
    details: "Qué vive en Redis, Mongo y RabbitMQ, qué ocurre sin cada dependencia y por qué health y readiness son preguntas distintas."
    link: /arquitectura#datos-y-degradacion
    linkText: Ver datos

  - icon: "🚀"
    title: "Operación"
    details: "Desarrollo local, múltiples procesos PM2, sondas, apagado ordenado, smoke real y despliegue con rollback."
    link: /operacion
    linkText: Operar el backend

  - icon: "📐"
    title: "Decisiones y reglas"
    details: "Reglas heredadas de v1 y documentos que explican por qué el port de truco tomó cada decisión."
    link: /reglas-de-juego-v1
    linkText: Leer reglas
---

## Inicio rápido

```bash
npm install
npm run docs:dev
```

VitePress imprime la URL local, normalmente `http://localhost:5173`. La búsqueda funciona sin un
servicio externo. Los diagramas permiten zoom con la rueda, desplazamiento por arrastre y controles
de encuadre.

::: info Alcance
El sitio describe el backend actual. Los planes fechados de `docs/superpowers/plans/` son historial
de ejecución y no se publican; las especificaciones que justifican decisiones sí aparecen en la
barra lateral.
:::
