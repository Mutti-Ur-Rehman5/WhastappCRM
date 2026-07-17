import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { initSocket } from './services/socket.service.js';

const startServer = async () => {
  // Connect Database
  await connectDB();

  // Create HTTP Server
  const server = http.createServer(app);

  // Initialize Socket.io
  initSocket(server, env.CLIENT_URL);

  // Start Server
  server.listen(env.PORT, () => {
    console.log(`[SERVER] WaCRM Backend running on http://localhost:${env.PORT}`);
  });
};

startServer();
