# studio-ui. Contexto de build = studio/ (a UI importa o contrato do grafo de
# ../api/src/shared, fonte unica entre os dois).
FROM node:22-bookworm-slim AS build
WORKDIR /studio/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY api/src/shared /studio/api/src/shared
COPY ui/ ./
RUN npx vite build

FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV API_PROXY_TARGET=http://studio-api
COPY ui/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /studio/ui/dist /usr/share/nginx/html
EXPOSE 8080
