FROM node:24.8.0

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8001

CMD ["node", "src/app.js"]
