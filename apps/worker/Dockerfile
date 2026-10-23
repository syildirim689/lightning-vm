FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node *.mjs ./
USER node
CMD ["node", "index.mjs"]
