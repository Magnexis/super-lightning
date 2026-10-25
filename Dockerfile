FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY super-lightning.config.example.json ./super-lightning.config.example.json

EXPOSE 8787
CMD ["node", "src/cli.js", "--config", "/app/super-lightning.config.json"]
