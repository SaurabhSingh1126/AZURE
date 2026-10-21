const { Server } = require('socket.io');

let io = null;
const connectedDevices = new Map();

function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    },
    pingInterval: 15000,
    pingTimeout: 10000
  });

  io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    const userAgent = socket.handshake.headers['user-agent'] || 'Unknown Device';
    const deviceId = socket.handshake.query.deviceId || socket.id;

    connectedDevices.set(socket.id, {
      socketId: socket.id,
      deviceId,
      clientIp,
      userAgent,
      connectedAt: new Date().toISOString()
    });

    console.log(`[Socket.IO] Device connected: ${deviceId} (${clientIp}). Total online: ${connectedDevices.size}`);

    // Welcome handshake
    socket.emit('connected', {
      success: true,
      socketId: socket.id,
      serverTime: new Date().toISOString(),
      activeDevicesCount: connectedDevices.size,
      message: 'Connected to Azure Hospitality Real-Time Cloud Hub'
    });

    // Device subscription to property room
    socket.on('join_property', (property) => {
      socket.join(property);
      console.log(`[Socket.IO] Device ${deviceId} joined room: ${property}`);
    });

    socket.on('disconnect', (reason) => {
      connectedDevices.delete(socket.id);
      console.log(`[Socket.IO] Device disconnected: ${deviceId} (${reason}). Remaining: ${connectedDevices.size}`);
    });

    socket.on('error', (err) => {
      console.error(`[Socket.IO] Error on socket ${socket.id}:`, err.message);
    });
  });

  return io;
}

function broadcast(eventType, data = {}, meta = {}) {
  if (!io) return;
  const payload = {
    type: eventType,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };

  console.log(`[Realtime Broadcast] Event: ${eventType} -> ${connectedDevices.size} active device(s)`);
  io.emit(eventType, payload);
  // Also emit generic event for unified handler
  io.emit('azure_event', payload);
}

function getActiveDevices() {
  return Array.from(connectedDevices.values());
}

module.exports = {
  initRealtime,
  broadcast,
  getActiveDevices,
  getIO: () => io
};
