import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "Dominó Betaso",
    description: "Arquitectura, reglas y operación del backend de dominó",
    srcExclude: ["superpowers/plans/**"],
    themeConfig: {
      nav: [
        { text: "Inicio", link: "/" },
        { text: "Arquitectura", link: "/arquitectura" },
        { text: "API y mensajes", link: "/api-y-mensajes" },
        { text: "Operación", link: "/operacion" },
        { text: "Reglas v1", link: "/reglas-de-juego-v1" },
      ],
      sidebar: [
        {
          text: "Sistema actual",
          items: [
            { text: "Visión general", link: "/" },
            { text: "Arquitectura y flujos", link: "/arquitectura" },
            { text: "API HTTP y mensajes", link: "/api-y-mensajes" },
            { text: "Operación y despliegue", link: "/operacion" },
            { text: "Reglas y anatomía de v1", link: "/reglas-de-juego-v1" },
          ],
        },
        {
          text: "Decisiones de diseño",
          collapsed: true,
          items: [
            {
              text: "Port de la arquitectura de truco",
              link: "/superpowers/specs/2026-09-09-domino-v2-port-arquitectura-truco-design",
            },
            {
              text: "Identidad y smoke PM2",
              link: "/superpowers/specs/2026-09-14-identidad-multiplataforma-y-smoke-pm2-design",
            },
            {
              text: "Catálogo y outbox",
              link: "/superpowers/specs/2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design",
            },
            { text: "Orquestador futuro", link: "/orquestador-multiplataforma" },
          ],
        },
      ],
      search: {
        provider: "local",
        options: {
          locales: {
            root: {
              translations: {
                button: { buttonText: "Buscar", buttonAriaLabel: "Buscar" },
                modal: {
                  noResultsText: "Sin resultados para",
                  resetButtonTitle: "Limpiar búsqueda",
                  footer: {
                    selectText: "seleccionar",
                    navigateText: "navegar",
                    closeText: "cerrar",
                  },
                },
              },
            },
          },
        },
      },
      outline: { level: [2, 3], label: "En esta página" },
      socialLinks: [{ icon: "github", link: "https://github.com/Betaso-Team/domino-backend-v2" }],
    },
    vite: {
      optimizeDeps: {
        include: ["mermaid", "svg-pan-zoom"],
      },
    },
  }),
);
