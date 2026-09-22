# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /app
# Teto de RAM do BUILD: o `vite build` roda no daemon do Docker, fora de
# qualquer cgroup do cluster, e o V8 dimensiona o heap pela RAM da maquina. 2 GB
# e bem acima do pico deste bundle e impede o build de empurrar o WSL p/ o swap.
ENV NODE_OPTIONS=--max-old-space-size=2048
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx-conf/nginx.conf /etc/nginx/template/default.conf.template
COPY public/env.template.js /usr/share/nginx/html/env.template.js
COPY --chmod=755 nginx-conf/entrypoint.sh /entrypoint.sh

# `worker_processes auto` dimensiona pelo numero de cores do NO, nao pelo
# `limits.cpu` do container. A imagem oficial ja traz o calculo certo (le a
# quota do cgroup em /docker-entrypoint.d/); ele so e ativado por esta env.
ENV NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE=1

EXPOSE 8080
CMD ["/entrypoint.sh"]
