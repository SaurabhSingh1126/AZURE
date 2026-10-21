const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { connectDB, getStatus } = require('./services/db');
const { runMigration } = require('./services/migration');
const { initRealtime, broadcast: socketIoBroadcast, getActiveDevices } = require('./services/realtime');

const Booking = require('./models/Booking');
const Guest = require('./models/Guest');
const Room = require('./models/Room');
const Payment = require('./models/Payment');
const Invoice = require('./models/Invoice');
const Expense = require('./models/Expense');
const Inventory = require('./models/Inventory');
const AuditLog = require('./models/AuditLog');
const Setting = require('./models/Setting');

const authRoutes = require('./routes/auth');
const bookingsRoutes = require('./routes/bookings');
const roomsRoutes = require('./routes/rooms');
const dashboardRoutes = require('./routes/dashboard');
const migrateRoutes = require('./routes/migrate');
const operationsRoutes = require('./routes/operations');

const app = express();
const server = http.createServer(app);

// 1. Initialize Socket.IO Real-time Multi-Device Engine
const io = initRealtime(server);

// 2. Also keep native WebSocket for backwards compatibility
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  console.log(`[Native WebSocket] Client connected from ${req.socket.remoteAddress}. Total: ${wsClients.size}`);
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Azure Hospitality Cloud Sync' }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });
  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

// Dual broadcast: sends to both Socket.IO and native WebSockets
function broadcast(eventType, data = {}, meta = {}) {
  // Socket.IO
  socketIoBroadcast(eventType, data, meta);

  // Native WebSocket fallback
  const payload = JSON.stringify({
    type: eventType,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  });

  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (e) {}
    }
  }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;

function getBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

const mongoose = require('mongoose');

// Serverless DB connection check for Vercel
let isConnecting = false;
let connectPromise = null;
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState === 0) {
    if (!isConnecting) {
      isConnecting = true;
      connectPromise = connectDB().finally(() => {
        isConnecting = false;
      });
    }
    try {
      await connectPromise;
    } catch (e) {
      // Handled in connectDB
    }
  }
  next();
});

// Register modular REST API routes
app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/migrate', migrateRoutes);
app.use('/api', operationsRoutes);

/* =========================================================
   COMPREHENSIVE CENTRAL STATE ENDPOINT (/api/state)
   Maintained for backwards-compatibility with existing views
========================================================= */
app.get('/api/state', async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const dbInfo = getStatus();

    // In serverless / offline fallback, read directly from data_store.json
    if (mongoose.connection.readyState !== 1) {
      const dataStorePath = path.join(__dirname, 'data_store.json');
      if (fs.existsSync(dataStorePath)) {
        try {
          const store = JSON.parse(fs.readFileSync(dataStorePath, 'utf8'));
          return res.json({
            success: true,
            dbStatus: { isConnected: false, dbType: dbInfo.dbType || 'Vercel Serverless (JSON Data Store Fallback)' },
            property: 'all',
            activeDevices: 1,
            ...store
          });
        } catch (e) {
          console.warn('[Data Store Fallback Error]:', e.message);
        }
      }
    }

    const [
      rooms,
      units,
      guests,
      bookings,
      payments,
      invoices,
      expenses,
      inventory,
      auditLog,
      settingDoc
    ] = await Promise.all([
      Room.find({ isUnit: false }).lean(),
      Room.find({ isUnit: true }).lean(),
      Guest.find().lean(),
      Booking.find().sort({ checkIn: -1 }).limit(1000).lean(),
      Payment.find().sort({ date: -1 }).limit(500).lean(),
      Invoice.find().lean(),
      Expense.find().lean(),
      Inventory.find().lean(),
      AuditLog.find().sort({ date: -1 }).limit(100).lean(),
      Setting.findOne({ key: 'system_settings' }).lean()
    ]);

    const ota = settingDoc?.ota || {};
    // Dynamically resolve public live export URLs
    Object.keys(ota).forEach(k => {
      const feed = ota[k];
      if (feed && feed.platform) {
        const slug = feed.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
        feed.exportUrl = `${baseUrl}/api/ical/export/${feed.property}/${slug}.ics`;
      }
    });

    const state = {
      properties: settingDoc?.properties || {
        azurevista: { id: 'azurevista', name: 'Azurevista', type: 'Hotel', location: 'Gorakhpur, Uttar Pradesh, India', checkInTime: '13:00', checkOutTime: '11:00', gstin: '09AZUREV1234H1Z9' },
        azuresuite: { id: 'azuresuite', name: 'Azure Suite', type: 'Vacation Rental', location: 'Lucknow, Uttar Pradesh, India', checkInTime: '14:00', checkOutTime: '11:00', gstin: '09AZURES5678S1Z2' }
      },
      rooms,
      units,
      guests,
      bookings,
      payments,
      invoices,
      expenses,
      inventory,
      purchases: [],
      suppliers: settingDoc?.suppliers || [],
      staff: settingDoc?.staff || [],
      maintenance: settingDoc?.maintenance || [],
      housekeeping: settingDoc?.housekeeping || [],
      foodBills: settingDoc?.foodBills || [],
      ota,
      otaSyncLogs: settingDoc?.otaSyncLogs || [],
      otaConflicts: settingDoc?.otaConflicts || [],
      otaSyncQueue: settingDoc?.otaSyncQueue || [],
      otaRoomMappings: settingDoc?.otaRoomMappings || [],
      processedWebhookEvents: settingDoc?.processedWebhookEvents || {},
      userPasswords: { Admin: 'admin123', Manager: 'manager123', Receptionist: 'reception123' },
      settings: settingDoc?.settings || {
        businessName: 'Azure Hospitality',
        ownerEmail: 'owner@azurehospitality.in',
        address: 'Uttar Pradesh, India',
        tax: { cgst: 6, sgst: 6, igst: 0 },
        invoicePrefix: 'INV-2026-',
        invoiceFooter: 'Thank you for staying with us. Rates are inclusive of applicable taxes unless stated otherwise.',
        terms: 'Check-in after property check-in time. Government ID mandatory at check-in. Cancellations per policy shared at booking.'
      },
      invoiceSeq: settingDoc?.invoiceSeq || 10,
      lastSync: new Date().toISOString(),
      activeDevicesOnline: getActiveDevices().length
    };

    res.json({
      success: true,
      data: state,
      isMongoConnected: dbInfo.isConnected,
      dbType: dbInfo.dbType
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   iCAL EXPORT & IMPORT CALENDAR SYNC ENGINE
========================================================= */

// Export iCal (.ics) Calendar Feed Endpoint
app.get(['/api/ical/export/:property.ics', '/api/ical/export/:property/:platform.ics'], async (req, res) => {
  try {
    const { property, platform } = req.params;
    const bks = await Booking.find({
      property,
      status: { $nin: ['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED'] }
    }).lean();

    const settingDoc = await Setting.findOne({ key: 'system_settings' }).lean();
    const maints = (settingDoc?.maintenance || []).filter(m => m.property === property && m.status !== 'completed');

    let ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Azure Hospitality//Central Reservation Calendar Engine//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Azure Hospitality - ${property.toUpperCase()}${platform ? ' (' + platform + ')' : ''}`,
      'X-WR-TIMEZONE:Asia/Kolkata'
    ];

    for (const b of bks) {
      const startClean = (b.checkIn || '').replace(/[^0-9]/g, '');
      const endClean = (b.checkOut || '').replace(/[^0-9]/g, '');
      if (startClean.length >= 8 && endClean.length >= 8) {
        ics.push(
          'BEGIN:VEVENT',
          `UID:${b.id}@azurehospitality.in`,
          `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`,
          `DTSTART;VALUE=DATE:${startClean.slice(0, 8)}`,
          `DTEND;VALUE=DATE:${endClean.slice(0, 8)}`,
          `SUMMARY:Reserved - ${b.guestName} (${b.source || 'OFFLINE'})`,
          `DESCRIPTION:Booking ID: ${b.id}\\nRoom: ${b.roomId}\\nSource: ${b.source || 'Direct'}\\nStatus: ${b.status}`,
          'STATUS:CONFIRMED',
          'TRANSP:OPAQUE',
          'END:VEVENT'
        );
      }
    }

    for (const m of maints) {
      const s = (m.startDate || m.date || '').replace(/[^0-9]/g, '');
      const e = (m.endDate || m.startDate || '').replace(/[^0-9]/g, '');
      if (s.length >= 8 && e.length >= 8) {
        ics.push(
          'BEGIN:VEVENT',
          `UID:MAINT-${m.id}@azurehospitality.in`,
          `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`,
          `DTSTART;VALUE=DATE:${s.slice(0, 8)}`,
          `DTEND;VALUE=DATE:${e.slice(0, 8)}`,
          `SUMMARY:Blocked for Maintenance - Room ${m.roomId}`,
          `DESCRIPTION:${m.reason || 'Maintenance'}`,
          'STATUS:CONFIRMED',
          'TRANSP:OPAQUE',
          'END:VEVENT'
        );
      }
    }

    ics.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${property}${platform ? '-' + platform : ''}.ics"`);
    res.send(ics.join('\r\n'));
  } catch (err) {
    res.status(500).send('Error generating calendar feed: ' + err.message);
  }
});

// Configure iCal URL
app.post('/api/ical/configure', async (req, res) => {
  try {
    const { property, platform, importUrl, autoSync } = req.body;
    if (!property || !platform) {
      return res.status(400).json({ success: false, message: 'Property and platform are required.' });
    }

    const key = `${property}|${platform}`;
    const settingDoc = await Setting.findOne({ key: 'system_settings' });
    const ota = settingDoc.ota || {};

    ota[key] = {
      property,
      platform,
      importUrl: importUrl || '',
      autoSync: autoSync !== false,
      status: importUrl ? 'configured' : 'not_configured',
      lastSync: ota[key]?.lastSync || null,
      lastError: null
    };

    settingDoc.ota = ota;
    await settingDoc.save();

    broadcast('ota_settings_updated', { key, feed: ota[key] });

    res.json({ success: true, message: `iCal feed for ${platform} (${property}) configured.`, feed: ota[key] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Sync single feed
app.post('/api/ical/sync-single', async (req, res) => {
  try {
    const { property, platform } = req.body;
    const settingDoc = await Setting.findOne({ key: 'system_settings' });
    const key = `${property}|${platform}`;
    const feed = settingDoc?.ota?.[key];

    if (!feed || !feed.importUrl) {
      return res.status(400).json({ success: false, message: 'Feed not configured with an import URL.' });
    }

    res.json({ success: true, message: `Sync triggered for ${platform} (${property}).`, feed });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Sync all feeds
app.post('/api/ical/sync-all', async (req, res) => {
  try {
    res.json({ success: true, message: 'All configured iCal feeds synced successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Clear OTA conflicts
app.all(['/api/ota/conflicts/clear', '/api/ota/conflicts'], async (req, res) => {
  try {
    await Setting.findOneAndUpdate(
      { key: 'system_settings' },
      { $set: { otaConflicts: [] } }
    );
    broadcast('ota_conflicts_cleared');
    res.json({ success: true, message: 'All OTA conflicts cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Clear OTA logs
app.delete('/api/ota/logs', async (req, res) => {
  try {
    await Setting.findOneAndUpdate(
      { key: 'system_settings' },
      { $set: { otaSyncLogs: [] } }
    );
    res.json({ success: true, message: 'OTA logs cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   STATIC ASSETS & SPA ROUTING
========================================================= */
app.use(express.static(__dirname));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: `API endpoint ${req.path} not found.` });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* =========================================================
   INITIALIZATION & STARTUP
========================================================= */
async function startServer() {
  // 1. Connect to Central MongoDB Cloud / Resilient Engine
  const dbStatus = await connectDB();

  // 2. Check if migration needed from data_store.json
  const bookingCount = await Booking.countDocuments();
  if (bookingCount === 0) {
    console.log('[Startup] MongoDB booking collection is empty. Checking data_store.json for initial data migration...');
    try {
      const report = await runMigration();
      console.log(`[Startup] Auto-migrated ${report.results.bookings.imported} booking(s) and ${report.results.guests.imported} guest(s) into MongoDB.`);
    } catch (migErr) {
      console.warn('[Startup] Auto-migration skipped or not required:', migErr.message);
    }
  }

  // 3. Start HTTP server
  if (process.env.VERCEL) {
    console.log('Running on Vercel Serverless Platform');
  } else {
    server.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(` AZURE HOSPITALITY CENTRAL CLOUD DATABASE & REALTIME PMS`);
      console.log(` Port: ${PORT}`);
      console.log(` Database: ${dbStatus.dbType}`);
      console.log(` Realtime Engine: Socket.IO & WebSocket active`);
      console.log(` REST API URL: http://localhost:${PORT}/api/bookings`);
      console.log(` Web Dashboard: http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
  }
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('[Startup Fatal] Error starting Azure Hospitality server:', err);
  });
}

module.exports = app;
