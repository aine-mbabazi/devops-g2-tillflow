# Built from the repo root (docker build -f services/commission/Dockerfile .)
# so services/_shared is in the build context — the app imports it via a
# relative path (../../_shared/...) that only resolves if the monorepo
# directory layout is preserved inside the image.
FROM node:20-alpine

WORKDIR /app

COPY services/commission/package.json services/commission/package-lock.json ./
RUN npm ci --omit=dev

COPY services/commission/src ./src
COPY services/commission/migrations ./migrations
COPY services/_shared /_shared

USER node

# One-shot worker: EventBridge Scheduler runs this task once per day, it
# exits, and the next schedule starts a fresh task.
CMD ["node", "src/run.js"]
