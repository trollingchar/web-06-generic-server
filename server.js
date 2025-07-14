const express = require('express');
const http = require('http');
const WebSocket = require('ws'); // или native WebSocket в Node.js v22+
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


class User {
    constructor(socket) {
        this.id = this.generateId();
        this.socket = socket;
        this.nick = 'Player' + Math.floor(Math.random() * 1000);
        this.rooms = [];
    }

    generateId() {
        return crypto.randomBytes(6).toString('hex');
    }

    send(message) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }

    joinRoom(room) {
        if (!this.rooms.includes(room)) {
            this.rooms.push(room);
            room.addUser(this);
        }
    }

    leaveRoom(room) {
        this.rooms = this.rooms.filter(r => r.id !== room.id);
        room.removeUser(this);
    }
}


class Room {
    constructor(id, type = 'chat') {
        this.id = id;
        this.type = type; // chat / game
        this.users = [];
        this.messages = [];
    }

    addUser(user) {
        if (!this.users.find(u => u.id === user.id)) {
            this.users.push(user);
            this.broadcast({
                type: 'user_joined',
                user_id: user.id,
                nick: user.nick,
                room_id: this.id
            });
        }
    }

    removeUser(user) {
        this.users = this.users.filter(u => u.id !== user.id);
        this.broadcast({
            type: 'user_left',
            user_id: user.id,
            room_id: this.id
        });
    }

    broadcast(message, senderSocket = null) {
        this.messages.push(message);
        const payload = JSON.stringify(message);

        this.users.forEach(user => {
            if (senderSocket && user.socket === senderSocket) return;

            if (user.socket.readyState === WebSocket.OPEN) {
                user.socket.send(payload);
            }
        });
    }

    addMessage(message) {
        this.messages.push(message);
    }
}


// === Хранилище ===
const rooms = {}; // { roomId: Room }
const users = {}; // { userId: User }


wss.on('connection', (socket) => {
    const user = new User(socket);
    users[user.id] = user;

    // === Отправляем информацию о пользователе ===
    user.send({
        type: 'user_info',
        user_id: user.id,
        nick: user.nick
    });

    // === При получении сообщения ===
    socket.on('message', (rawMessage) => {
        try {
            const message = JSON.parse(rawMessage.toString());

            if (!message.type || !message.req_id) {
                return user.send({
                    type: 'error',
                    req_id: message.req_id || 'unknown',
                    error: 'Missing type or req_id'
                });
            }

            switch (message.type) {
                case 'change_nick': {
                    const newNick = message.nick;
                    if (newNick && typeof newNick === 'string') {
                        user.nick = newNick;
                        user.send({
                            type: 'ack',
                            req_id: message.req_id,
                            data: { nick: user.nick }
                        });
                    } else {
                        user.send({
                            type: 'error',
                            req_id: message.req_id,
                            error: 'Invalid nickname'
                        });
                    }
                    break;
                }

                case 'create_room': {
                    const { room_id, room_type } = message;
                    if (!room_id || typeof room_id !== 'string') {
                        return user.send({
                            type: 'error',
                            req_id: message.req_id,
                            error: 'Invalid room ID'
                        });
                    }

                    if (rooms[room_id]) {
                        return user.send({
                            type: 'error',
                            req_id: message.req_id,
                            error: 'Room already exists'
                        });
                    }

                    const newRoom = new Room(room_id, room_type || 'chat');
                    rooms[room_id] = newRoom;
                    user.joinRoom(newRoom);

                    user.send({
                        type: 'room_created',
                        req_id: message.req_id,
                        room_id: newRoom.id,
                        room_type: newRoom.type
                    });

                    // Рассылаем всем, что создана новая комната
                    broadcastRoomList();
                    break;
                }

                case 'join_room': {
                    const { room_id } = message;
                    const targetRoom = rooms[room_id];

                    if (!targetRoom) {
                        return user.send({
                            type: 'error',
                            req_id: message.req_id,
                            error: 'Room not found'
                        });
                    }

                    user.joinRoom(targetRoom);
                    user.send({
                        type: 'ack',
                        req_id: message.req_id,
                        data: {
                            room_id: room_id,
                            messages: targetRoom.messages.slice(-50)
                        }
                    });

                    // Сообщаем другим, что игрок зашёл
                    targetRoom.broadcast({
                        type: 'user_joined',
                        user_id: user.id,
                        nick: user.nick,
                        room_id: targetRoom.id
                    }, user.socket);
                    break;
                }

                case 'leave_room': {
                    const { room_id } = message;
                    const targetRoom = rooms[room_id];
                    if (!targetRoom) {
                        return user.send({
                            type: 'error',
                            req_id: message.req_id,
                            error: 'Room not found'
                        });
                    }

                    user.leaveRoom(targetRoom);

                    user.send({
                        type: 'ack',
                        req_id: message.req_id
                    });

                    targetRoom.broadcast({
                        type: 'user_left',
                        user_id: user.id,
                        room_id: targetRoom.id
                    }, user.socket);
                    break;
                }

                case 'send_message': {
                    const { room_id, content, message_type } = message;

                    const targetRoom = rooms[room_id];
                    if (!targetRoom) {
                        return user.send({
                            type: 'error',
                            req_id: message.req_id,
                            error: 'Room not found'
                        });
                    }

                    const msg = {
                        type: 'message',
                        req_id: message.req_id,
                        user_id: user.id,
                        nick: user.nick,
                        room_id: room_id,
                        content: content,
                        message_type: message_type,
                        timestamp: Date.now()
                    };

                    targetRoom.addMessage(msg);
                    targetRoom.broadcast(msg, user.socket);

                    user.send({
                        type: 'ack',
                        req_id: message.req_id
                    });
                    break;
                }

                default:
                    user.send({
                        type: 'error',
                        req_id: message.req_id,
                        error: `Unknown command: ${message.type}`
                    });
            }
        } catch (e) {
            console.error("Ошибка обработки сообщения:", e.message);
        }
    });

    socket.on('close', () => {
        // Удаляем пользователя из всех комнат
        Object.values(rooms).forEach(room => room.removeUser(user));
        delete users[user.id];
        broadcastRoomList();
    });
});


function broadcastRoomList() {
    const roomList = Object.values(rooms).map(r => ({
        id: r.id,
        type: r.type,
        user_count: r.users.length
    }));

    Object.values(users).forEach(user => {
        user.send({
            type: 'room_list',
            list: roomList
        });
    });
}


// Запуск сервера
const PORT = 10800;
server.listen(PORT, () => {
    console.log(`Пиратский сервер запущен на ws://localhost:${PORT}`);
});