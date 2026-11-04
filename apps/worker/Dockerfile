FROM node:26-alpine
WORKDIR /app
# rclone reads the ISO storages (FTP/FTPS, SFTP, WebDAV, S3, SMB, HTTP).
RUN apk add --no-cache rclone
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node *.mjs ./
USER node
CMD ["node", "index.mjs"]
