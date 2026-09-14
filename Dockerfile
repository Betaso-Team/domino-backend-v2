# syntax=docker/dockerfile:1

# --- build: instala todo y bundlea el server a dist/ con tsup ---
FROM node:22-alpine AS build
WORKDIR /app
# Sin `.npmrc`: truco copia el suyo acá, el dominó no tiene ninguno y un COPY de un archivo
# que no existe rompe el build.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: solo deps de producción + el bundle ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=2567
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 2567
# `dist/main.js`: el archivo que SE EJECUTA, separado del que se importa (ver la cabecera de
# `src/main.ts`). Es el mismo entrypoint que `npm start`, que el `script` de `ecosystem.config.cjs`
# y que el único `entry` de `tsup.config.ts` — los cuatro los pinea `src/entrypoint.test.ts`,
# porque ninguno de ellos rompe el gate al desincronizarse.
CMD ["node", "dist/main.js"]
