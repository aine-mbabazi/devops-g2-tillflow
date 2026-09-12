FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

USER node

CMD ["node", "src/server.js"]
