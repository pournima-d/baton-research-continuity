FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY .env.example ./.env.example

RUN mkdir -p /var/data/db /var/data/private_uploads

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DB_PATH=/var/data/db/baton.db
ENV PRIVATE_STORAGE_DIR=/var/data/private_uploads
ENV AUTO_SEED_IF_EMPTY=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/index.js"]
