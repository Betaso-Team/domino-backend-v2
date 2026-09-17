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

# Solo la certificación del deploy necesita PM2; la imagen normal conserva un único proceso.
FROM runtime AS smoke-server
RUN npm install --global pm2@7.0.4
COPY ecosystem.config.cjs ./
EXPOSE 2568
CMD ["pm2-runtime", "ecosystem.config.cjs"]

# El cliente necesita TypeScript y las devDependencies, ya presentes en build.
#
# ⚠ **Y NECESITA EL `tsconfig.json`**, que es lo que no se ve: `smoke:client` corre con `tsx`, y
# desde que los imports usan el alias `@/` es de ahí de donde `tsx` saca el `paths`. Lo trae el
# `COPY . .` de la etapa `build` —`.dockerignore` no lo excluye—, así que hoy funciona. Lo que
# rompe es DERIVAR ESTA ETAPA DE `runtime` para adelgazarla: ahí solo hay `dist/` y
# `package*.json`, y el smoke muere con un `ERR_MODULE_NOT_FOUND` sobre `@/env` que no dice que
# falta un archivo de configuración. Falla ruidoso, no en silencio, pero cuesta media hora.
FROM build AS smoke-client
CMD ["npm", "run", "smoke:client"]
