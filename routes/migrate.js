const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { runMigration } = require('../services/migration');
const Booking = require('../models/Booking');
const Guest = require('../models/Guest');
const Room = require('../models/Room');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const Expense = require('../models/Expense');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');
const Setting = require('../models/Setting');
const { optionalAuth, requireRole } = require('../middleware/auth');
const { broadcast } = require('../services/realtime');

// POST /api/migrate — Execute idempotent data migration into MongoDB
router.post('/', optionalAuth, async (req, res) => {
  try {
    const payload = req.body && Object.keys(req.body).length > 0 ? req.body : null;
    const report = await runMigration(payload);

    broadcast('database_migrated', {
      timestamp: report.timestamp,
      results: report.results
    });

    res.json({
      success: true,
      message: 'Migration into Central Cloud MongoDB completed successfully.',
      report
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/migrate/status — Check collection counts in MongoDB
router.get('/status', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      const { getStore } = require('../services/storeSync');
      const store = getStore();
      return res.json({
        success: true,
        database: 'JSON Data Store Fallback',
        collectionCounts: {
          bookings: (store.bookings || []).length,
          guests: (store.guests || []).length,
          rooms: ((store.rooms || []).length + (store.units || []).length),
          payments: (store.payments || []).length,
          invoices: (store.invoices || []).length,
          expenses: (store.expenses || []).length,
          inventory: (store.inventory || []).length,
          auditLogs: (store.auditLog || []).length
        },
        availableBackups: []
      });
    }

    const [
      bookingsCount,
      guestsCount,
      roomsCount,
      paymentsCount,
      invoicesCount,
      expensesCount,
      inventoryCount,
      auditLogsCount
    ] = await Promise.all([
      Booking.countDocuments(),
      Guest.countDocuments(),
      Room.countDocuments(),
      Payment.countDocuments(),
      Invoice.countDocuments(),
      Expense.countDocuments(),
      Inventory.countDocuments(),
      AuditLog.countDocuments()
    ]);

    const backupDir = path.join(__dirname, '..', 'backups');
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.json')) : [];

    res.json({
      success: true,
      database: 'MongoDB Central Cloud Database',
      collectionCounts: {
        bookings: bookingsCount,
        guests: guestsCount,
        rooms: roomsCount,
        payments: paymentsCount,
        invoices: invoicesCount,
        expenses: expensesCount,
        inventory: inventoryCount,
        auditLogs: auditLogsCount
      },
      availableBackups: backups
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/backup — Generate full production database snapshot
router.get('/backup', optionalAuth, async (req, res) => {
  try {
    const [
      bookings, guests, rooms, payments,
      invoices, expenses, inventory, auditLog, setting
    ] = await Promise.all([
      Booking.find().lean(),
      Guest.find().lean(),
      Room.find().lean(),
      Payment.find().lean(),
      Invoice.find().lean(),
      Expense.find().lean(),
      Inventory.find().lean(),
      AuditLog.find().sort({ date: -1 }).limit(500).lean(),
      Setting.findOne({ key: 'system_settings' }).lean()
    ]);

    const backup = {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      data: {
        bookings,
        guests,
        rooms,
        payments,
        invoices,
        expenses,
        inventory,
        auditLog,
        properties: setting?.properties || {},
        settings: setting?.settings || {},
        ota: setting?.ota || {},
        otaSyncLogs: setting?.otaSyncLogs || [],
        otaConflicts: setting?.otaConflicts || []
      }
    };

    const fileName = `azure_hospitality_backup_${Date.now()}.json`;
    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, fileName), JSON.stringify(backup, null, 2), 'utf8');

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/migrate/connect-cloud — Connect to remote MongoDB Atlas and optionally sync data
router.post('/connect-cloud', async (req, res) => {
  try {
    let { uri, password } = req.body || {};
    const dotenv = require('dotenv');
    const envParsed = dotenv.config().parsed || {};

    const DEFAULT_URI_TEMPLATE = 'mongodb+srv://saurabhsinghvishen26_db_user:<db_password>@azure.6fmtnyz.mongodb.net/azure_hospitality?retryWrites=true&w=majority';

    let targetUri = (uri || process.env.MONGODB_URI || envParsed.MONGODB_URI || envParsed['mongodb.uri'] || '').trim();

    // If input was given in password field and looks like a full mongodb URI:
    if (password && (password.startsWith('mongodb://') || password.startsWith('mongodb+srv://'))) {
      targetUri = password.trim();
      password = '';
    }

    if (!targetUri) {
      targetUri = DEFAULT_URI_TEMPLATE;
    }

    if (password && targetUri.includes('<db_password>')) {
      targetUri = targetUri.replace('<db_password>', encodeURIComponent(password));
    }

    if (!targetUri || targetUri.includes('<db_password>')) {
      return res.status(400).json({
        success: false,
        message: 'Please provide your MongoDB Atlas password to connect.'
      });
    }

    const { switchConnection } = require('../services/db');
    const result = await switchConnection(targetUri);

    // Save working URI to /tmp/azure_mongo_uri.txt (always writable on Vercel)
    try {
      fs.writeFileSync('/tmp/azure_mongo_uri.txt', targetUri, 'utf8');
    } catch (e) {}

    // Also attempt saving to .env for local persistence
    try {
      const envPath = path.join(__dirname, '..', '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('MONGODB_URI=')) {
          envContent = envContent.replace(/MONGODB_URI=.*(\r?\n|$)/, `MONGODB_URI=${targetUri}\n`);
        } else {
          envContent = `MONGODB_URI=${targetUri}\n` + envContent;
        }
        if (envContent.includes('mongodb.uri=')) {
          envContent = envContent.replace(/mongodb\.uri=.*(\r?\n|$)/, `mongodb.uri=${targetUri}\n`);
        } else {
          envContent = `mongodb.uri=${targetUri}\n` + envContent;
        }
        fs.writeFileSync(envPath, envContent, 'utf8');
      }
    } catch (e) {}

    // If destination DB has 0 bookings, auto-populate from backup
    const bookingCount = await Booking.countDocuments();
    let migrated = false;
    if (bookingCount === 0) {
      const { runMigration } = require('../services/migration');
      await runMigration();
      migrated = true;
    }

    const newCounts = {
      bookings: await Booking.countDocuments(),
      guests: await Guest.countDocuments(),
      rooms: await Room.countDocuments()
    };

    broadcast('database_connected', {
      dbType: result.dbType,
      migrated,
      counts: newCounts
    });

    res.json({
      success: true,
      message: `Successfully connected to ${result.dbType}!`,
      dbType: result.dbType,
      uri: targetUri,
      migrated,
      counts: newCounts
    });
  } catch (err) {
    console.error('[MongoDB Connect Error]:', err.message);
    res.status(500).json({
      success: false,
      message: err.message,
      help: (err.message.includes('SSL') || err.message.includes('whitelist') || err.message.includes('tlsv1'))
        ? 'Atlas Network Access required: In MongoDB Atlas, go to Network Access -> Add IP Address -> Add 0.0.0.0/0 (or 122.161.50.185).'
        : (err.message.includes('auth') ? 'Authentication failed: Check your database user password in MongoDB Atlas.' : '')
    });
  }
});

module.exports = router;
