FROM node:latest AS base
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY *.js ./
COPY *.ts ./
RUN npm install
ENTRYPOINT ["npm", "start"]