FROM node:lts-bookworm-slim
RUN mkdir -p /app
WORKDIR /app
COPY package.json /app
RUN npm install
COPY . .
RUN adduser --disabled-password mnt2sync \
        && mkdir -p /etc/sudoers.d \
        && echo "$USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/mnt2sync \
    && chmod 0440 /etc/sudoers.d/mnt2sync
USER mnt2sync
EXPOSE 19520
CMD node server.js
