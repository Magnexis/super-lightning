FROM node:20-alpine

WORKDIR /app
COPY services/licensing ./services/licensing

EXPOSE 4242
VOLUME ["/app/data"]
CMD ["node", "services/licensing/server.js"]
