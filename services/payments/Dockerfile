# Built from the repo root (docker build -f services/payments/Dockerfile .)
# so services/_shared is in the build context — the app imports it via a
# relative path (../../_shared/...) that only resolves if the monorepo
# directory layout is preserved inside the image.
FROM node:20-alpine

WORKDIR /app

COPY services/payments/package.json services/payments/package-lock.json ./services/payments/
RUN npm install --prefix services/payments --omit=dev

COPY services/payments/src ./services/payments/src
COPY services/_shared ./services/_shared

ENV HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

USER node

CMD ["node", "services/payments/src/server.js"]
