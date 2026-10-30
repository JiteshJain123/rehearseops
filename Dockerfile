FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 4173
USER node
CMD ["node", "server.mjs"]
