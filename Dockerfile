FROM node:22.23.3-bookworm-slim AS verified
WORKDIR /app
COPY LICENSE package.json server.mjs ./
COPY src ./src
COPY public ./public
COPY tests ./tests
COPY deploy/cloudflare-pilot/worker.mjs deploy/cloudflare-pilot/schema.sql ./deploy/cloudflare-pilot/
RUN npm test

FROM node:22.23.3-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATABASE_PATH=/app/data/weather.sqlite NWAC_ENABLED=false
WORKDIR /app
COPY --from=verified /app/LICENSE /app/package.json /app/server.mjs ./
COPY --from=verified /app/src ./src
COPY --from=verified /app/public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
