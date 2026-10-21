const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// Disable buffering globally so queries fail immediately or fall back rather than hanging for 10000ms
mongoose.set('bufferCommands', false);

let mongoMemoryServer = null;
let isConnected = false;
let dbType = 'Disconnected';
let activeUri = '';

const dotenv = require('dotenv');
const envParsed = dotenv.config().parsed || {};

async function connectDB() {
  const envUri = (
    process.env.MONGODB_URI ||
    envParsed.MONGODB_URI ||
    envParsed['mongodb.uri'] ||
    envParsed['mongodb_uri'] ||
    process.env['mongodb.uri'] ||
    process.env.mongodb_uri ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  // 1. If an explicit MONGODB_URI is provided, attempt connection
  if (envUri && !envUri.includes('127.0.0.1:27017') && !envUri.includes('localhost:27017')) {
    try {
      console.log(`[MongoDB] Connecting to Cloud Database: ${envUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')}`);
      await mongoose.connect(envUri, {
        serverSelectionTimeoutMS: 2500,
        bufferCommands: false
      });
      isConnected = true;
      dbType = envUri.includes('mongodb+srv') ? 'MongoDB Atlas (Cloud)' : 'MongoDB Remote Server';
      activeUri = envUri;
      console.log(`[MongoDB] Successfully connected to ${dbType}!`);
      await seedDefaultData();
      return { isConnected, dbType, uri: activeUri };
    } catch (err) {
      console.warn(`[MongoDB] Failed to connect to specified MONGODB_URI: ${err.message}`);
      try {
        await mongoose.disconnect();
      } catch (discErr) {}
    }
  }

  // 2. Try local mongodb daemon if standard port is reachable
  if (envUri && (envUri.includes('127.0.0.1:27017') || envUri.includes('localhost:27017'))) {
    try {
      console.log('[MongoDB] Checking local mongod at 127.0.0.1:27017...');
      await mongoose.connect(envUri, {
        serverSelectionTimeoutMS: 2000
      });
      isConnected = true;
      dbType = 'MongoDB Local Instance';
      activeUri = envUri;
      console.log('[MongoDB] Connected to local MongoDB instance!');
      await seedDefaultData();
      return { isConnected, dbType, uri: activeUri };
    } catch (e) {
      console.log('[MongoDB] Local mongod not running, starting resilient embedded MongoDB engine...');
    }
  }

  // 3. Skip embedded binary engine on Vercel/serverless environments
  if (process.env.VERCEL || process.env.NOW_REGION) {
    console.warn('[MongoDB] Running on Vercel serverless platform. Remote MONGODB_URI (e.g. MongoDB Atlas) will be used when configured; using fallback data store for instantaneous serverless cold starts.');
    return { isConnected: false, dbType: 'Vercel Serverless (JSON Data Store Fallback)' };
  }

  // 4. Resilient embedded MongoDB engine via MongoMemoryServer (persistent on disk in ./backups/mongodb_data)
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const dbDir = path.join(__dirname, '..', 'backups', 'mongodb_data');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log('[MongoDB] Initializing resilient Central MongoDB Engine (Disk-backed)...');
    mongoMemoryServer = await MongoMemoryServer.create({
      instance: {
        dbPath: dbDir,
        storageEngine: 'wiredTiger'
      }
    });

    const uri = mongoMemoryServer.getUri() + 'azure_hospitality';
    await mongoose.connect(uri);
    isConnected = true;
    dbType = 'Central MongoDB Engine (Local Persistent)';
    activeUri = uri;
    console.log(`[MongoDB] Central MongoDB Engine online at: ${uri}`);
    await seedDefaultData();
    return { isConnected, dbType, uri: activeUri };
  } catch (err) {
    console.error('[MongoDB Critical] Could not start embedded MongoDB:', err.message);
    // In memory fallback if wiredTiger path locked
    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      mongoMemoryServer = await MongoMemoryServer.create();
      const uri = mongoMemoryServer.getUri() + 'azure_hospitality';
      await mongoose.connect(uri);
      isConnected = true;
      dbType = 'Central MongoDB Engine (In-Memory Fallback)';
      activeUri = uri;
      console.log(`[MongoDB] Connected to MongoDB engine at: ${uri}`);
      await seedDefaultData();
      return { isConnected, dbType, uri: activeUri };
    } catch (fatal) {
      console.error('[MongoDB Fatal] Database initialization failed:', fatal.message);
      return { isConnected: false, dbType: 'Error', error: fatal.message };
    }
  }
}

async function seedDefaultData() {
  const User = require('../models/User');
  const Room = require('../models/Room');
  const Setting = require('../models/Setting');

  // Seed default admin users if not present
  const userCount = await User.countDocuments();
  if (userCount === 0) {
    const defaultUsers = [
      {
        username: 'admin',
        email: 'admin@azurehospitality.in',
        password: 'admin123',
        role: 'Admin',
        name: 'You (Owner / Admin)',
        icon: '🛡️'
      },
      {
        username: 'manager',
        email: 'manager@azurehospitality.in',
        password: 'manager123',
        role: 'Manager',
        name: 'Neha Kapoor (Manager)',
        icon: '👔'
      },
      {
        username: 'reception',
        email: 'reception@azurehospitality.in',
        password: 'reception123',
        role: 'Receptionist',
        name: 'Sanjay Yadav (Receptionist)',
        icon: '🎧'
      }
    ];

    for (const u of defaultUsers) {
      await User.create(u);
    }
    console.log('[MongoDB] Seeded default layered authentication users (Admin, Manager, Receptionist)');
  }

  // Seed default rooms if none exist
  const roomCount = await Room.countDocuments();
  if (roomCount === 0) {
    const defaultRooms = [
      { id: 'RM-101', property: 'azurevista', number: '101', type: 'Standard', rate: 3000, status: 'occupied' },
      { id: 'RM-102', property: 'azurevista', number: '102', type: 'Standard', rate: 1786, status: 'available' },
      { id: 'RM-103', property: 'azurevista', number: '103', type: 'Standard', rate: 3125, status: 'available' },
      { id: 'RM-104', property: 'azurevista', number: '104', type: 'Standard', rate: 1786, status: 'available' },
      { id: 'RM-105', property: 'azurevista', number: '105', type: 'Deluxe', rate: 3200, status: 'available' },
      { id: 'RM-106', property: 'azurevista', number: '106', type: 'Deluxe', rate: 3200, status: 'available' },
      { id: 'RM-107', property: 'azurevista', number: '107', type: 'Deluxe', rate: 3200, status: 'available' },
      { id: 'RM-108', property: 'azurevista', number: '108', type: 'Suite', rate: 4800, status: 'available' },
      { id: 'RM-201', property: 'azurevista', number: '201', type: 'Deluxe', rate: 3125, status: 'available' },
      { id: 'RM-203', property: 'azurevista', number: '203', type: 'Standard', rate: 1786, status: 'available' },
      { id: 'UN-1', property: 'azuresuite', number: 'Azure Suite', type: '2BHK Apartment', rate: 6500, status: 'available', isUnit: true }
    ];
    await Room.insertMany(defaultRooms);
    console.log('[MongoDB] Seeded default rooms and units');
  }

  // Seed settings if none exist
  const settingDoc = await Setting.findOne({ key: 'system_settings' });
  if (!settingDoc) {
    await Setting.create({
      key: 'system_settings',
      properties: {
        azurevista: { id: 'azurevista', name: 'Azurevista', type: 'Hotel', location: 'Gorakhpur, Uttar Pradesh, India', checkInTime: '13:00', checkOutTime: '11:00', gstin: '09AZUREV1234H1Z9' },
        azuresuite: { id: 'azuresuite', name: 'Azure Suite', type: 'Vacation Rental', location: 'Lucknow, Uttar Pradesh, India', checkInTime: '14:00', checkOutTime: '11:00', gstin: '09AZURES5678S1Z2' }
      },
      settings: {
        businessName: 'Azure Hospitality',
        ownerEmail: 'owner@azurehospitality.in',
        address: 'Uttar Pradesh, India',
        tax: { cgst: 6, sgst: 6, igst: 0 },
        invoicePrefix: 'INV-2026-',
        invoiceFooter: 'Thank you for staying with us. Rates are inclusive of applicable taxes unless stated otherwise.',
        terms: 'Check-in after property check-in time. Government ID mandatory at check-in. Cancellations per policy shared at booking.'
      },
      suppliers: [
        { id: 'SUP-1', name: 'Shine Distributors', phone: '9812345670', email: 'orders@shinedist.in', gstin: '09ABCDE1234F1Z5', products: 'Toiletries, cleaning supplies', outstanding: 0 },
        { id: 'SUP-2', name: 'Lucknow Linens Co.', phone: '9856781234', email: 'sales@lucknowlinens.in', gstin: '09FGHIJ5678K2Z1', products: 'Linen, towels, bedsheets', outstanding: 0 }
      ],
      staff: [
        { id: 'ST-1', name: 'You (Owner)', phone: '9800000001', email: 'owner@azurehospitality.in', role: 'Owner', property: 'all', joined: '2023-01-01', status: 'Active' }
      ]
    });
    console.log('[MongoDB] Seeded default system settings');
  }
}

async function stopDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoMemoryServer) {
    await mongoMemoryServer.stop();
  }
  isConnected = false;
}

async function testConnection(targetUri) {
  const conn = await mongoose.createConnection(targetUri, { serverSelectionTimeoutMS: 6000 }).asPromise();
  await conn.close();
  return true;
}

async function switchConnection(newUri) {
  const previousUri = activeUri;
  const previousType = dbType;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  try {
    await mongoose.connect(newUri, { serverSelectionTimeoutMS: 10000 });
    isConnected = true;
    dbType = newUri.includes('mongodb+srv') ? 'MongoDB Atlas (Cloud)' : 'MongoDB Remote Server';
    activeUri = newUri;
    console.log(`[MongoDB] Switched active connection to: ${dbType}`);
    await seedDefaultData();
    return { isConnected, dbType, uri: activeUri };
  } catch (err) {
    console.error(`[MongoDB] Switch to new URI failed: ${err.message}. Restoring previous connection...`);
    if (previousUri) {
      try {
        await mongoose.connect(previousUri);
        isConnected = true;
        dbType = previousType;
        activeUri = previousUri;
      } catch (restoreErr) {
        console.error('[MongoDB] Failed to restore previous connection:', restoreErr.message);
      }
    }
    throw err;
  }
}

module.exports = {
  connectDB,
  stopDB,
  testConnection,
  switchConnection,
  getStatus: () => ({ isConnected, dbType, activeUri })
};
