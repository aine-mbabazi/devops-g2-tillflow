FROM node:20-alpine

WORKDIR /app

COPY services/pos/package.json services/pos/package-lock.json ./
RUN npm ci --omit=dev

COPY services/pos/src ./src
COPY services/pos/migrations ./migrations
COPY services/_shared /_shared

ENV HOST=0.0.0.0
ENV PORT=3002

EXPOSE 3002

USER node

CMD ["node", "--import", "./src/register.js", "--import", "./src/telemetry.js", "src/server.js"]
