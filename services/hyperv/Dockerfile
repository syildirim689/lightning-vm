# No dependencies: the adapter is the Node standard library and five files.
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs winrm.mjs handlers.mjs scripts.mjs iso.mjs ./
# uid 1000 (node) matches the owner of the mounted service token file.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
