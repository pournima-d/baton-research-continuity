FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY .env.example ./.env.example

RUN mkdir -p data storage/private_uploads

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DB_PATH=./data/baton.db
ENV PRIVATE_STORAGE_DIR=./storage/private_uploads
ENV AUTO_SEED_IF_EMPTY=true

CMD ["node", "server/index.js"]
