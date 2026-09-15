FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

USER node

CMD ["node", "--import", "./src/register.js", "--import", "./src/telemetry.js", "src/server.js"]
