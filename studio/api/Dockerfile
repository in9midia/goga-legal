# studio-api. Contexto de build = RAIZ do repositorio (o script passa `-f`),
# porque a imagem leva junto os conjuntos de avaliacao da KB
# (knowledge-base/content/evaluation) para o lote da F7.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY studio/api/package.json studio/api/package-lock.json ./
RUN npm ci
COPY studio/api/tsconfig.json studio/api/tsconfig.build.json ./
COPY studio/api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 STUDIO_FILES_DIR=/data/files STUDIO_EVAL_DIR=/app/evaluation
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY studio/api/package.json ./
COPY studio/api/drizzle ./drizzle
COPY studio/api/seed ./seed
COPY knowledge-base/content/evaluation ./evaluation
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
