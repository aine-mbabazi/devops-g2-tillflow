FROM node:20-alpine

WORKDIR /app

COPY services/web/package.json services/web/package-lock.json ./
RUN npm ci --omit=dev

COPY services/web/src ./src
COPY services/_shared /_shared

ENV HOST=0.0.0.0
ENV PORT=3003

EXPOSE 3003

USER node

CMD ["node", "--import", "./src/register.js", "--import", "./src/telemetry.js", "src/server.js"]
