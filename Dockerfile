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
# `dist/index.js` y no `dist/main.js`: el dominó no tiene el split `index.ts`/`main.ts` de
# truco. Es el mismo entrypoint que `npm start` y el único `entry` de `tsup.config.ts`.
CMD ["node", "dist/index.js"]
