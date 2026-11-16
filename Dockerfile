FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["sh", "-c", "npm run start"]
