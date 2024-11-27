FROM node:latest AS base
WORKDIR /app
COPY * ./
RUN npm install
ENTRYPOINT ["npm", "start"]