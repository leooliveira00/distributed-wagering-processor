FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun reads tsconfig.json at runtime for experimentalDecorators/emitDecoratorMetadata (NestJS DI).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
USER bun
EXPOSE 3000

CMD ["bun", "src/main.ts"]
