# No npm dependencies: the adapter is the Node standard library, five files and the OpenSSH client.
FROM node:22-alpine
RUN apk add --no-cache openssh-client sshpass
WORKDIR /app
COPY --chown=node:node package.json server.mjs ssh.mjs handlers.mjs scripts.mjs iso.mjs ./
# uid 1000 (node) matches the owner of the mounted service token file.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
