FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

USER node

CMD ["node", "src/server.js"]
