import { Server } from 'socket.io';

let io = null;

export const initSocket = (server, clientUrl) => {
  io = new Server(server, {
    cors: {
      origin: clientUrl,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  io.on('connection', (socket) => {
    console.log(`[SOCKET] Client connected: ${socket.id}`);

    // Join room when authenticated/assigned
    socket.on('join', (userId) => {
      socket.join(userId);
      console.log(`[SOCKET] Client ${socket.id} joined room: ${userId}`);
    });

    // Join admin global room
    socket.on('join_admin', () => {
      socket.join('admin_global');
      console.log(`[SOCKET] Client ${socket.id} joined room: admin_global`);
    });

    socket.on('disconnect', () => {
      console.log(`[SOCKET] Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io is not initialized!');
  }
  return io;
};

export const emitToUser = (userId, event, data) => {
  if (io) {
    io.to(userId).emit(event, data);
  }
};

export const emitToAdmin = (event, data) => {
  if (io) {
    io.to('admin_global').emit(event, data);
  }
};

export const broadcast = (event, data) => {
  if (io) {
    io.emit(event, data);
  }
};
