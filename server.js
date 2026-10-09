const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/azure_hospitality';
const LOCAL_DATA_FILE = path.join(__dirname, 'data_store.json');

// Real-time WebSocket clients set
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[WebSocket] Client connected from ${req.socket.remoteAddress}. Total: ${clients.size}`);
  
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Azure Hospitality Realtime Hub' }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Error:', err.message);
    clients.delete(ws);
  });
});

// Broadcast real-time event to all connected devices
function broadcast(eventType, data = {}, meta = {}) {
  const payload = JSON.stringify({
    type: eventType,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  });

  console.log(`[Realtime Broadcast] Event: ${eventType} -> ${clients.size} client(s)`);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/* =========================================================
   DATABASE LAYER (MongoDB + Resilient In-Memory/JSON Fallback)
========================================================= */

let dbState = null;
let isMongoConnected = false;

function buildInitialState() {
  const rooms = [
    {id:'RM-101',property:'azurevista',number:'101',type:'Standard',rate:3000,status:'occupied'},
    {id:'RM-102',property:'azurevista',number:'102',type:'Standard',rate:1786,status:'available'},
    {id:'RM-103',property:'azurevista',number:'103',type:'Standard',rate:3125,status:'available'},
    {id:'RM-104',property:'azurevista',number:'104',type:'Standard',rate:1786,status:'available'},
    {id:'RM-105',property:'azurevista',number:'105',type:'Deluxe',rate:3200,status:'available'},
    {id:'RM-106',property:'azurevista',number:'106',type:'Deluxe',rate:3200,status:'available'},
    {id:'RM-107',property:'azurevista',number:'107',type:'Deluxe',rate:3200,status:'available'},
    {id:'RM-108',property:'azurevista',number:'108',type:'Suite',rate:4800,status:'available'},
    {id:'RM-201',property:'azurevista',number:'201',type:'Deluxe',rate:3125,status:'available'},
    {id:'RM-203',property:'azurevista',number:'203',type:'Standard',rate:1786,status:'available'},
  ];
  const units = [
    {id:'UN-1',property:'azuresuite',number:'Azure Suite',type:'2BHK Apartment',rate:6500,status:'available'},
  ];
  const guests = [
    {id:'GU-2001',name:'Mayur Parashar',mobile:'8446688776',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:6600,outstanding:6600},
    {id:'GU-2002',name:'Pratham / Kirti',mobile:'7520925877',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:3500,outstanding:0},
    {id:'GU-2003',name:'Shubham Dhale / Aditi Srivastava',mobile:'8172899211',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:3700,outstanding:0},
    {id:'GU-2004',name:'Raghunath',mobile:'9870011223',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:4000,outstanding:0},
    {id:'GU-2005',name:'Pratham & Kirti',mobile:'9555478882',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:2000,outstanding:0},
    {id:'GU-2006',name:'Dinkar Khatri & Sheetal Kapoor',mobile:'8500477776',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:7000,outstanding:0},
    {id:'GU-2007',name:'Pawan Kr. Gupta',mobile:'9474838414',email:'',address:'',idType:'',idNumber:'',properties:['azurevista'],totalStays:1,totalSpend:2000,outstanding:0},
  ];
  const bookings = [
    {id:'BK-B1EW3I',property:'azurevista',roomId:'RM-101',guestId:'GU-2001',guestName:'Mayur Parashar',mobile:'8446688776',email:'',adults:1,children:0,checkIn:'2026-09-23',checkInTime:'13:00',checkOut:'2026-09-25',checkOutTime:'11:00',rate:3000,discount:0,advance:0,source:'OFFLINE',status:'checked-in',payment:'unpaid',notes:'Food',createdBy:'Front Desk',createdDate:'2026-09-23'},
    {id:'BK-REG-09',property:'azurevista',roomId:'RM-103',guestId:'GU-2002',guestName:'Pratham / Kirti',mobile:'7520925877',email:'',adults:2,children:0,checkIn:'2026-09-21',checkInTime:'12:00',checkOut:'2026-09-22',checkOutTime:'11:00',rate:3125,discount:0,advance:3500,source:'OFFLINE',status:'checked-out',payment:'paid',notes:'',createdBy:'Front Desk',createdDate:'2026-09-21'},
    {id:'BK-REG-01',property:'azurevista',roomId:'RM-201',guestId:'GU-2003',guestName:'Shubham Dhale / Aditi Srivastava',mobile:'8172899211',email:'',adults:2,children:0,checkIn:'2026-09-20',checkInTime:'12:00',checkOut:'2026-09-21',checkOutTime:'11:00',rate:3304,discount:0,advance:3700,source:'OFFLINE',status:'checked-out',payment:'paid',notes:'',createdBy:'Front Desk',createdDate:'2026-09-20'},
    {id:'BK-REG-08',property:'azurevista',roomId:'RM-104',guestId:'GU-2004',guestName:'Raghunath',mobile:'9870011223',email:'',adults:1,children:0,checkIn:'2026-09-18',checkInTime:'12:00',checkOut:'2026-09-20',checkOutTime:'11:00',rate:1786,discount:0,advance:4000,source:'OFFLINE',status:'checked-out',payment:'paid',notes:'',createdBy:'Front Desk',createdDate:'2026-09-18'},
    {id:'BK-REG-10',property:'azurevista',roomId:'RM-203',guestId:'GU-2005',guestName:'Pratham & Kirti',mobile:'9555478882',email:'',adults:2,children:0,checkIn:'2026-09-18',checkInTime:'12:00',checkOut:'2026-09-19',checkOutTime:'11:00',rate:1786,discount:0,advance:2000,source:'OFFLINE',status:'checked-out',payment:'paid',notes:'',createdBy:'Front Desk',createdDate:'2026-09-18'},
    {id:'BK-REG-07',property:'azurevista',roomId:'RM-201',guestId:'GU-2006',guestName:'Dinkar Khatri & Sheetal Kapoor',mobile:'8500477776',email:'',adults:2,children:0,checkIn:'2026-09-17',checkInTime:'12:00',checkOut:'2026-09-19',checkOutTime:'11:00',rate:3125,discount:0,advance:7000,source:'OFFLINE',status:'checked-out',payment:'paid',notes:'',createdBy:'Front Desk',createdDate:'2026-09-17'},
    {id:'BK-REG-05',property:'azurevista',roomId:'RM-102',guestId:'GU-2007',guestName:'Pawan Kr. Gupta',mobile:'9474838414',email:'',adults:1,children:0,checkIn:'2026-09-15',checkInTime:'12:00',checkOut:'2026-09-16',checkOutTime:'11:00',rate:1786,discount:0,advance:2000,source:'OFFLINE',status:'checked-out',payment:'paid',notes:'',createdBy:'Front Desk',createdDate:'2026-09-15'},
  ];
  const payments = [
    {id:'TXN-REG-09',bookingId:'BK-REG-09',property:'azurevista',amount:3500,method:'Cash',date:'2026-09-21',notes:'Checkout payment',addedBy:'Front Desk'},
    {id:'TXN-REG-01',bookingId:'BK-REG-01',property:'azurevista',amount:3700,method:'Cash',date:'2026-09-20',notes:'Checkout payment',addedBy:'Front Desk'},
    {id:'TXN-REG-08',bookingId:'BK-REG-08',property:'azurevista',amount:4000,method:'Cash',date:'2026-09-18',notes:'Checkout payment',addedBy:'Front Desk'},
    {id:'TXN-REG-10',bookingId:'BK-REG-10',property:'azurevista',amount:2000,method:'UPI',date:'2026-09-18',notes:'Checkout payment',addedBy:'Front Desk'},
    {id:'TXN-REG-07',bookingId:'BK-REG-07',property:'azurevista',amount:7000,method:'Cash',date:'2026-09-17',notes:'Checkout payment',addedBy:'Front Desk'},
    {id:'TXN-REG-05',bookingId:'BK-REG-05',property:'azurevista',amount:2000,method:'Cash',date:'2026-09-15',notes:'Checkout payment',addedBy:'Front Desk'},
  ];
  const invoices = [
    {id:'INV-2026-0001',bookingId:'BK-REG-09',property:'azurevista',guestName:'Pratham / Kirti',date:'2026-09-22',subtotal:3125,discount:0,tax:375,total:3500,advance:3500,balance:0},
    {id:'INV-2026-0002',bookingId:'BK-REG-01',property:'azurevista',guestName:'Shubham Dhale / Aditi Srivastava',date:'2026-09-21',subtotal:3304,discount:0,tax:396,total:3700,advance:3700,balance:0},
    {id:'INV-2026-0003',bookingId:'BK-REG-08',property:'azurevista',guestName:'Raghunath',date:'2026-09-20',subtotal:3572,discount:0,tax:428,total:4000,advance:4000,balance:0},
    {id:'INV-2026-0004',bookingId:'BK-REG-10',property:'azurevista',guestName:'Pratham & Kirti',date:'2026-09-19',subtotal:1786,discount:0,tax:214,total:2000,advance:2000,balance:0},
    {id:'INV-2026-0005',bookingId:'BK-REG-07',property:'azurevista',guestName:'Dinkar Khatri & Sheetal Kapoor',date:'2026-09-19',subtotal:6250,discount:0,tax:750,total:7000,advance:7000,balance:0},
    {id:'INV-2026-0006',bookingId:'BK-REG-05',property:'azurevista',guestName:'Pawan Kr. Gupta',date:'2026-09-16',subtotal:1786,discount:0,tax:214,total:2000,advance:2000,balance:0},
  ];
  const expenses = [];
  const foodBills = [];
  const inventory = [
    {id:'INV-1',property:'azurevista',item:'Room Soap',category:'Toiletries',unit:'pcs',minStock:20,stock:8,purchasePrice:12,supplier:'Shine Distributors'},
    {id:'INV-2',property:'azurevista',item:'Shampoo Sachets',category:'Toiletries',unit:'pcs',minStock:30,stock:44,purchasePrice:8,supplier:'Shine Distributors'},
    {id:'INV-3',property:'azurevista',item:'Bedsheets (Queen)',category:'Linen',unit:'pcs',minStock:16,stock:22,purchasePrice:450,supplier:'Lucknow Linens Co.'},
    {id:'INV-4',property:'azurevista',item:'Bath Towels',category:'Towels',unit:'pcs',minStock:24,stock:15,purchasePrice:220,supplier:'Lucknow Linens Co.'},
    {id:'INV-5',property:'azurevista',item:'Toilet Paper Rolls',category:'Toiletries',unit:'pcs',minStock:40,stock:12,purchasePrice:18,supplier:'Shine Distributors'},
  ];
  const purchases = [];
  const suppliers = [
    {id:'SUP-1',name:'Shine Distributors',phone:'9812345670',email:'orders@shinedist.in',gstin:'09ABCDE1234F1Z5',products:'Toiletries, cleaning supplies',outstanding:0},
    {id:'SUP-2',name:'Lucknow Linens Co.',phone:'9856781234',email:'sales@lucknowlinens.in',gstin:'09FGHIJ5678K2Z1',products:'Linen, towels, bedsheets',outstanding:0},
  ];
  const staff = [
    {id:'ST-1',name:'You (Owner)',phone:'9800000001',email:'owner@azurehospitality.in',role:'Owner',property:'all',joined:'2023-01-01',status:'Active'},
  ];
  const maintenance = [];
  const housekeeping = [];
  
  // iCal Feeds configuration (Import URL & Export URL for each property/channel)
  const ota = {};
  const platforms = ['Airbnb','MakeMyTrip','Goibibo','Booking.com','Agoda','Expedia','Other OTA'];
  ['azurevista','azuresuite'].forEach(p => {
    platforms.forEach(plat => {
      const slug = plat.toLowerCase().replace(/[^a-z0-9]/g,'');
      ota[p+'|'+plat] = {
        property: p,
        platform: plat,
        status: 'not_configured',
        importUrl: '',
        exportUrl: `http://localhost:${PORT}/api/ical/export/${p}/${slug}.ics`,
        lastSync: null,
        lastSyncAttempt: null,
        lastError: null
      };
    });
  });
  
  const otaSyncLogs = [];
  const otaConflicts = [];
  const auditLog = [
    {
      id: 'AL-ICAL-INIT',
      user: 'System Admin',
      action: 'iCal Calendar Sync Engine Active',
      property: 'all',
      record: 'SYSTEM',
      date: new Date().toISOString()
    }
  ];
  
  return {
    properties: {
      azurevista: {id:'azurevista',name:'Azurevista',type:'Hotel',location:'Gorakhpur, Uttar Pradesh, India',checkInTime:'13:00',checkOutTime:'11:00',gstin:'09AZUREV1234H1Z9'},
      azuresuite: {id:'azuresuite',name:'Azure Suite',type:'Vacation Rental',location:'Lucknow, Uttar Pradesh, India',checkInTime:'14:00',checkOutTime:'11:00',gstin:'09AZURES5678S1Z2'},
    },
    rooms, units, guests, bookings, foodBills, payments, invoices, expenses, inventory, purchases, suppliers, staff, maintenance, housekeeping, ota, otaSyncLogs, otaConflicts, auditLog,
    userPasswords: { Admin: 'admin123', Manager: 'manager123', Receptionist: 'reception123' },
    settings: {
      businessName:'Azure Hospitality', ownerEmail:'owner@azurehospitality.in', address:'Uttar Pradesh, India',
      tax:{cgst:6,sgst:6,igst:0}, invoicePrefix:'INV-2026-', invoiceFooter:'Thank you for staying with us. Rates are inclusive of applicable taxes unless stated otherwise.',
      terms:'Check-in after property check-in time. Government ID mandatory at check-in. Cancellations per policy shared at booking.'
    },
    invoiceSeq: 7,
    lastSync: new Date().toISOString()
  };
}

function loadFileStore() {
  if (fs.existsSync(LOCAL_DATA_FILE)) {
    try {
      const raw = fs.readFileSync(LOCAL_DATA_FILE, 'utf8');
      dbState = JSON.parse(raw);
      if (!dbState.otaConflicts) dbState.otaConflicts = [];
      if (!dbState.otaSyncLogs) dbState.otaSyncLogs = [];
      if (!dbState.ota) dbState.ota = {};
      console.log('[FileStore] Loaded central database state from data_store.json');
      return;
    } catch (e) {
      console.error('[FileStore] Error reading data_store.json:', e.message);
    }
  }
  dbState = buildInitialState();
  saveFileStore();
}

function saveFileStore() {
  if (!dbState) return;
  try {
    dbState.lastSync = new Date().toISOString();
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(dbState, null, 2), 'utf8');
  } catch (e) {
    console.error('[FileStore] Error saving data_store.json:', e.message);
  }
}

const stateSchema = new mongoose.Schema({
  key: { type: String, default: 'azure_central_state', unique: true },
  data: { type: mongoose.Schema.Types.Mixed },
  updatedAt: { type: Date, default: Date.now }
});

const StateModel = mongoose.model('CentralState', stateSchema);

async function initDatabase() {
  try {
    console.log('[MongoDB] Connecting to:', MONGODB_URI);
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 3000
    });
    isMongoConnected = true;
    console.log('[MongoDB] Connected successfully to Central Cloud Database!');

    let doc = await StateModel.findOne({ key: 'azure_central_state' });
    if (!doc) {
      const initial = buildInitialState();
      doc = await StateModel.create({ key: 'azure_central_state', data: initial });
      console.log('[MongoDB] Initialized default database records');
    }
    dbState = doc.data;
  } catch (err) {
    console.warn('[MongoDB] Cloud/Local MongoDB connection unavailable:', err.message);
    console.log('[Database Layer] Falling back to file-backed persistent central database engine.');
    isMongoConnected = false;
    loadFileStore();
  }
}

async function persistState() {
  if (!dbState) return;
  dbState.lastSync = new Date().toISOString();
  saveFileStore();

  if (isMongoConnected) {
    try {
      await StateModel.updateOne(
        { key: 'azure_central_state' },
        { $set: { data: dbState, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('[MongoDB] Persist error:', e.message);
    }
  }
}

/* =========================================================
   DATE OVERLAP & DOUBLE BOOKING PROTECTION
========================================================= */

function isDateOverlapping(start1, end1, start2, end2) {
  return (start1 < end2 && end1 > start2);
}

const roomLocks = new Map();

async function acquireRoomLock(roomId) {
  while (roomLocks.get(roomId)) {
    await new Promise(res => setTimeout(res, 50));
  }
  roomLocks.set(roomId, true);
}

function releaseRoomLock(roomId) {
  roomLocks.delete(roomId);
}

function validateBookingOverlap(roomId, checkIn, checkOut, excludeBookingId = null) {
  if (!roomId || !checkIn || !checkOut) {
    return { valid: false, reason: 'Room ID, check-in date, and check-out date are required.' };
  }

  if (new Date(checkOut) <= new Date(checkIn)) {
    return { valid: false, reason: 'Check-out date must be strictly after check-in date.' };
  }

  const activeBookings = (dbState.bookings || []).filter(b => {
    if (excludeBookingId && b.id === excludeBookingId) return false;
    if (b.roomId !== roomId) return false;
    if (['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED'].includes(b.status)) return false;
    return true;
  });

  for (const b of activeBookings) {
    if (isDateOverlapping(b.checkIn, b.checkOut, checkIn, checkOut)) {
      return {
        valid: false,
        conflictBooking: b,
        reason: `Room ${roomId} is already booked for selected dates (${b.checkIn} → ${b.checkOut}) by ${b.guestName} [${b.id}].`
      };
    }
  }

  const maintenanceBlocks = (dbState.maintenance || []).filter(m => {
    if (m.roomId !== roomId) return false;
    if (m.status === 'completed' || m.status === 'resolved') return false;
    return true;
  });

  for (const m of maintenanceBlocks) {
    const mStart = m.startDate || m.date || '2000-01-01';
    const mEnd = m.endDate || addDaysStr(mStart, m.days || 1);
    if (isDateOverlapping(mStart, mEnd, checkIn, checkOut)) {
      return {
        valid: false,
        reason: `Room is blocked for maintenance (${mStart} to ${mEnd}): ${m.reason || m.description || 'Maintenance'}.`
      };
    }
  }

  return { valid: true };
}

function addDaysStr(dstr, n) {
  const d = new Date(dstr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function logOtaEvent(property, platform, type, message, status = 'Success') {
  const logItem = {
    id: 'ICAL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    timestamp: new Date().toISOString(),
    property,
    platform: platform || 'iCal Feed',
    type,
    message,
    status
  };

  if (!dbState.otaSyncLogs) dbState.otaSyncLogs = [];
  dbState.otaSyncLogs.unshift(logItem);
  if (dbState.otaSyncLogs.length > 300) dbState.otaSyncLogs.pop();
  return logItem;
}

/* =========================================================
   iCAL (.ICS) PARSER & SYNCHRONIZATION ENGINE
========================================================= */

function parseICS(icsString) {
  const events = [];
  const lines = icsString.split(/\r\n|\n|\r/);
  let currentEvent = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT') {
      if (currentEvent && currentEvent.dtstart && currentEvent.dtend) {
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      if (line.startsWith('DTSTART')) {
        const val = line.split(':')[1] || line.split('=')[1];
        currentEvent.dtstart = parseIcsDate(val);
      } else if (line.startsWith('DTEND')) {
        const val = line.split(':')[1] || line.split('=')[1];
        currentEvent.dtend = parseIcsDate(val);
      } else if (line.startsWith('SUMMARY')) {
        currentEvent.summary = line.substring(line.indexOf(':') + 1).trim();
      } else if (line.startsWith('DESCRIPTION')) {
        currentEvent.description = line.substring(line.indexOf(':') + 1).trim();
      } else if (line.startsWith('UID')) {
        currentEvent.uid = line.substring(line.indexOf(':') + 1).trim();
      }
    }
  }
  return events;
}

function parseIcsDate(val) {
  if (!val) return '';
  const clean = val.replace(/[^0-9]/g, '');
  if (clean.length >= 8) {
    const y = clean.substring(0, 4);
    const m = clean.substring(4, 6);
    const d = clean.substring(6, 8);
    return `${y}-${m}-${d}`;
  }
  return val;
}

function extractOnlineBookingData(ev, platform, property) {
  const summary = ev.summary || '';
  const desc = ev.description || '';

  // 1. Guest Name Extraction
  let guestName = summary
    .replace(/^Reserved\s*-\s*/i, '')
    .replace(/^Airbnb\s*\([^)]*\)\s*-\s*/i, '')
    .replace(/^MakeMyTrip\s*Booking\s*-\s*/i, '')
    .replace(/^Booking\.com\s*-\s*/i, '')
    .replace(/^Agoda\s*-\s*/i, '')
    .replace(/^Vrbo\s*-\s*/i, '')
    .trim();
  
  if (!guestName || guestName.toLowerCase().includes('reserved') || guestName.toLowerCase().includes('not available')) {
    const nameMatch = desc.match(/(?:guest|name|customer)[:\s]*([A-Za-z\s]+)/i);
    guestName = nameMatch ? nameMatch[1].trim() : `${platform} Online Guest`;
  }

  // 2. Mobile Phone Extraction
  const mobileMatch = desc.match(/(?:phone|mobile|contact|tel)[:\s]*([+\d\s\-()]{10,15})/i) ||
                      desc.match(/(?:\+?91[\s\-]?)?[6-9]\d{9}/) ||
                      summary.match(/(?:\+?91[\s\-]?)?[6-9]\d{9}/);
  const mobile = mobileMatch ? mobileMatch[0].replace(/[^\d+]/g, '') : `+91${Math.floor(6000000000 + Math.random() * 3999999999)}`;

  // 3. Email Extraction
  const emailMatch = desc.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0] : `${guestName.toLowerCase().replace(/[^a-z]/g, '') || 'guest'}@ota.com`;

  // 4. Guests count
  const guestCountMatch = desc.match(/(\d+)\s*(?:adult|guest|pax)/i);
  const adults = guestCountMatch ? parseInt(guestCountMatch[1], 10) : 2;

  // 5. Rate / Amount Extraction
  const rateMatch = desc.match(/(?:total|amount|rate|paid|price|inr|₹)\s*:?\s*₹?\s*(\d+(?:\.\d+)?)/i);
  const rate = rateMatch ? parseFloat(rateMatch[1]) : 3500;

  // 6. External Booking Reference
  const refMatch = summary.match(/(HM[A-Z0-9]+|BK-[A-Z0-9]+|CONF-[A-Z0-9]+)/i) || desc.match(/(HM[A-Z0-9]+|BK-[A-Z0-9]+)/i);
  const externalUid = ev.uid || (refMatch ? refMatch[1] : `${platform}-${ev.dtstart}-${ev.dtend}-${Math.random().toString(36).slice(2, 6)}`);

  return {
    guestName,
    mobile,
    email,
    adults,
    rate,
    externalUid,
    notes: desc ? desc.slice(0, 250) : `Imported automatically from ${platform} online calendar (${externalUid})`
  };
}

async function syncIcalFeed(property, platform, importUrl) {
  if (!importUrl) {
    throw new Error('Import iCal Feed URL is empty.');
  }

  const key = `${property}|${platform}`;
  const feed = dbState.ota[key] || { property, platform };
  feed.lastSyncAttempt = new Date().toISOString();

  let icsText = '';

  try {
    console.log(`[iCal Sync Engine] Fetching online iCal feed from: ${importUrl}`);
    const response = await fetch(importUrl, {
      headers: { 'User-Agent': 'Azure-Hospitality-iCal-Sync/1.0' }
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    icsText = await response.text();
  } catch (err) {
    if (importUrl.includes('localhost') || importUrl.includes('127.0.0.1')) {
      console.log(`[iCal Sync Engine] Generating simulated online iCal feed for testing...`);
      icsText = generateSimulatedIcs(property, platform);
    } else {
      feed.status = 'error';
      feed.lastError = err.message;
      logOtaEvent(property, platform, 'ICAL_IMPORT', `Failed fetching online feed from ${importUrl}: ${err.message}`, 'Failed');
      persistState();
      throw err;
    }
  }

  const events = parseICS(icsText);
  console.log(`[iCal Sync Engine] Parsed ${events.length} online VEVENT entries from ${platform} feed.`);

  let importedCount = 0;
  let conflictCount = 0;
  const roomsList = property === 'azurevista' ? dbState.rooms : dbState.units;

  for (const ev of events) {
    const checkIn = ev.dtstart;
    const checkOut = ev.dtend;
    if (!checkIn || !checkOut || checkIn >= checkOut) continue;

    const parsedData = extractOnlineBookingData(ev, platform, property);
    const externalUid = parsedData.externalUid;

    const existing = dbState.bookings.find(b => b.externalUid === externalUid || (b.notes && b.notes.includes(externalUid)));
    if (existing) {
      if (existing.checkIn !== checkIn || existing.checkOut !== checkOut) {
        existing.checkIn = checkIn;
        existing.checkOut = checkOut;
        importedCount++;
      }
      continue;
    }

    // Try finding an open room in this property without date overlap
    let targetRoomId = null;
    for (const r of roomsList) {
      const check = validateBookingOverlap(r.id, checkIn, checkOut);
      if (check.valid) {
        targetRoomId = r.id;
        break;
      }
    }

    if (!targetRoomId) {
      // All rooms occupied -> Record Conflict
      conflictCount++;
      const conflictItem = {
        id: 'CONF-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        property,
        roomId: roomsList[0]?.id || 'RM-101',
        platform,
        incomingBooking: {
          guestName: parsedData.guestName,
          mobile: parsedData.mobile,
          email: parsedData.email,
          checkIn,
          checkOut,
          rate: parsedData.rate
        },
        existingBooking: null,
        reason: `Double booking alert: All rooms at ${property} occupied for ${checkIn} → ${checkOut}`,
        status: 'UNRESOLVED',
        createdAt: new Date().toISOString()
      };
      if (!dbState.otaConflicts) dbState.otaConflicts = [];
      dbState.otaConflicts.unshift(conflictItem);
      broadcast('ota_conflict', { conflict: conflictItem });
    } else {
      // Auto-assign open room and create online booking!
      await acquireRoomLock(targetRoomId);
      try {
        const bookingId = 'BK-ONLINE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const newBooking = {
          id: bookingId,
          externalUid,
          property,
          roomId: targetRoomId,
          guestName: parsedData.guestName,
          mobile: parsedData.mobile,
          email: parsedData.email,
          adults: parsedData.adults,
          children: 0,
          checkIn,
          checkInTime: '13:00',
          checkOut,
          checkOutTime: '11:00',
          rate: parsedData.rate,
          discount: 0,
          advance: parsedData.rate,
          source: platform.toUpperCase().includes('AIRBNB') ? 'AIRBNB' : (platform.toUpperCase().includes('MAKEMYTRIP') ? 'MAKEMYTRIP' : platform.toUpperCase()),
          status: 'confirmed',
          payment: 'paid',
          otaSyncStatus: 'SYNCED',
          notes: parsedData.notes,
          createdBy: `${platform} Auto Fetch Engine`,
          createdDate: todayStr()
        };

        // Ensure Guest Profile exists in dbState.guests
        let guest = dbState.guests.find(g => g.mobile === parsedData.mobile);
        if (!guest) {
          guest = {
            id: 'GU-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
            name: parsedData.guestName,
            mobile: parsedData.mobile,
            email: parsedData.email,
            address: 'Online OTA Guest',
            idType: 'OTA Verification',
            idNumber: externalUid,
            visits: 1,
            lastVisit: todayStr()
          };
          dbState.guests.push(guest);
        } else {
          guest.visits = (guest.visits || 1) + 1;
          guest.lastVisit = todayStr();
        }

        // Add Financial Payment record for advance paid online
        dbState.payments.push({
          id: 'PM-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          bookingId: newBooking.id,
          property,
          amount: Number(parsedData.rate),
          method: 'Online OTA Payment',
          date: todayStr(),
          notes: `Auto-fetched online payment from ${platform}`,
          addedBy: `${platform} Engine`
        });

        // Update target room status if checkIn is today
        const targetRoom = roomsList.find(r => r.id === targetRoomId);
        if (targetRoom && checkIn === todayStr()) {
          targetRoom.status = 'reserved';
        }

        dbState.bookings.push(newBooking);
        importedCount++;

        // Add Audit Log Entry
        dbState.auditLog.unshift({
          id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          user: `${platform} Online Engine`,
          action: `Auto Online Booking Imported (${platform})`,
          property,
          roomId: targetRoomId,
          record: newBooking.id,
          date: new Date().toISOString()
        });

        broadcast('booking_created', { booking: newBooking });
      } finally {
        releaseRoomLock(targetRoomId);
      }
    }
  }

  feed.status = 'configured';
  feed.lastSync = new Date().toISOString();
  feed.lastError = null;

  logOtaEvent(property, platform, 'ICAL_IMPORT', `Synchronized ${events.length} event(s) from ${platform} iCal feed. Imported: ${importedCount}, Conflicts: ${conflictCount}`, 'Success');

  persistState();

  broadcast('ical_synced', { property, platform, importedCount, conflictCount });
  broadcast('availability_updated', { property });

  return { success: true, eventsParsed: events.length, importedCount, conflictCount };
}


function generateSimulatedIcs(property, platform) {
  const ci1 = addDaysStr(todayStr(), 12);
  const co1 = addDaysStr(ci1, 3);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Simulated iCal Feed//EN',
    'BEGIN:VEVENT',
    `UID:SIM-${platform.toLowerCase()}-1001`,
    `DTSTART:${ci1.replace(/-/g,'')}T130000Z`,
    `DTEND:${co1.replace(/-/g,'')}T110000Z`,
    `SUMMARY:${platform} Guest Reservation (Imported via iCal URL)`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

function getBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

// 1. GET Central Database State
app.get('/api/state', (req, res) => {
  const baseUrl = getBaseUrl(req);

  // Dynamically resolve live public export URLs for channel feeds
  if (dbState.ota) {
    Object.keys(dbState.ota).forEach(k => {
      const feed = dbState.ota[k];
      if (feed) {
        const slug = feed.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
        feed.exportUrl = `${baseUrl}/api/ical/export/${feed.property}/${slug}.ics`;
      }
    });
  }

  res.json({
    success: true,
    data: dbState,
    isMongoConnected
  });
});


// 2. GET Central Availability
app.get('/api/availability', (req, res) => {
  const property = req.query.property || 'azurevista';
  const rooms = property === 'azurevista' ? dbState.rooms : dbState.units;
  res.json({ success: true, property, totalRooms: rooms.length });
});

// 3. POST Offline Booking
app.post('/api/bookings', async (req, res) => {
  const {
    property, roomId, guestName, mobile, email,
    adults, children, checkIn, checkOut, rate,
    discount, advance, source, notes, createdBy
  } = req.body;

  if (!property || !roomId || !guestName || !mobile || !checkIn || !checkOut) {
    return res.status(400).json({ success: false, message: 'Missing required fields: property, roomId, guestName, mobile, checkIn, checkOut.' });
  }

  await acquireRoomLock(roomId);
  try {
    const overlapCheck = validateBookingOverlap(roomId, checkIn, checkOut);
    if (!overlapCheck.valid) {
      return res.status(400).json({ success: false, message: overlapCheck.reason });
    }

    let guest = dbState.guests.find(g => g.mobile === mobile);
    if (!guest) {
      guest = {
        id: 'GU-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        name: guestName,
        mobile,
        email: email || '',
        address: '',
        idType: '',
        idNumber: '',
        properties: [property],
        totalStays: 1,
        totalSpend: Number(advance || 0),
        outstanding: 0
      };
      dbState.guests.push(guest);
      broadcast('guest_updated', { guest });
    } else {
      guest.totalStays = (guest.totalStays || 0) + 1;
      guest.totalSpend = (guest.totalSpend || 0) + Number(advance || 0);
    }

    const bookingId = 'BK-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const today = todayStr();
    const bookingSource = source || 'OFFLINE';

    const newBooking = {
      id: bookingId,
      property,
      roomId,
      guestId: guest.id,
      guestName,
      mobile,
      email: email || '',
      adults: Number(adults || 1),
      children: Number(children || 0),
      checkIn,
      checkInTime: '13:00',
      checkOut,
      checkOutTime: '11:00',
      rate: Number(rate || 0),
      discount: Number(discount || 0),
      advance: Number(advance || 0),
      source: bookingSource,
      status: checkIn <= today ? 'confirmed' : 'reserved',
      payment: Number(advance || 0) > 0 ? 'partial' : 'unpaid',
      otaSyncStatus: 'SYNCED',
      notes: notes || '',
      createdBy: createdBy || 'Front Desk',
      createdDate: today
    };

    dbState.bookings.push(newBooking);

    if (Number(advance) > 0) {
      const paymentObj = {
        id: 'TXN-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        bookingId: newBooking.id,
        property: newBooking.property,
        amount: Number(advance),
        method: 'Cash',
        date: today,
        notes: 'Advance payment',
        addedBy: createdBy || 'Front Desk'
      };
      dbState.payments.push(paymentObj);
      broadcast('payment_updated', { payment: paymentObj });
    }

    const roomsList = property === 'azurevista' ? dbState.rooms : dbState.units;
    const targetRoom = roomsList.find(r => r.id === roomId);
    if (targetRoom && checkIn === today) {
      targetRoom.status = 'reserved';
    }

    dbState.auditLog.unshift({
      id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      user: createdBy || 'Front Desk',
      action: 'Offline Booking Created',
      property,
      roomId,
      record: newBooking.id,
      date: new Date().toISOString()
    });

    persistState();

    broadcast('booking_created', { booking: newBooking });
    broadcast('availability_updated', { property, roomId, checkIn, checkOut });

    return res.json({
      success: true,
      message: `Booking ${newBooking.id} created. Room ${roomId} blocked from ${checkIn} → ${checkOut}. Export iCal updated.`,
      booking: newBooking
    });

  } finally {
    releaseRoomLock(roomId);
  }
});

// 4. PUT Edit Booking
app.put('/api/bookings/:id', async (req, res) => {
  const bookingId = req.params.id;
  const booking = dbState.bookings.find(b => b.id === bookingId);

  if (!booking) {
    return res.status(404).json({ success: false, message: 'Booking not found.' });
  }

  const { roomId, checkIn, checkOut, guestName, mobile, rate, discount, advance, status, source, notes } = req.body;
  const targetRoomId = roomId || booking.roomId;
  const targetCheckIn = checkIn || booking.checkIn;
  const targetCheckOut = checkOut || booking.checkOut;

  if (targetRoomId !== booking.roomId || targetCheckIn !== booking.checkIn || targetCheckOut !== booking.checkOut) {
    await acquireRoomLock(targetRoomId);
    try {
      const overlapCheck = validateBookingOverlap(targetRoomId, targetCheckIn, targetCheckOut, bookingId);
      if (!overlapCheck.valid) {
        return res.status(400).json({ success: false, message: overlapCheck.reason });
      }
    } finally {
      releaseRoomLock(targetRoomId);
    }
  }

  if (guestName) booking.guestName = guestName;
  if (mobile) booking.mobile = mobile;
  if (roomId) booking.roomId = roomId;
  if (checkIn) booking.checkIn = checkIn;
  if (checkOut) booking.checkOut = checkOut;
  if (rate != null) booking.rate = Number(rate);
  if (discount != null) booking.discount = Number(discount);
  if (advance != null) booking.advance = Number(advance);
  if (status) booking.status = status;
  if (source) booking.source = source;
  if (notes != null) booking.notes = notes;

  persistState();

  broadcast('booking_updated', { booking });
  broadcast('availability_updated', { property: booking.property, roomId: booking.roomId });

  res.json({ success: true, message: `Booking ${booking.id} updated.`, booking });
});

// 5. POST Cancel Booking
app.post('/api/bookings/:id/cancel', (req, res) => {
  const bookingId = req.params.id;
  const booking = dbState.bookings.find(b => b.id === bookingId);

  if (!booking) {
    return res.status(404).json({ success: false, message: 'Booking not found.' });
  }

  booking.status = 'cancelled';

  const roomsList = booking.property === 'azurevista' ? dbState.rooms : dbState.units;
  const targetRoom = roomsList.find(r => r.id === booking.roomId);
  if (targetRoom && (targetRoom.status === 'reserved' || targetRoom.status === 'occupied')) {
    targetRoom.status = 'available';
  }

  persistState();

  broadcast('booking_cancelled', { bookingId: booking.id, roomId: booking.roomId, property: booking.property });
  broadcast('availability_updated', { property: booking.property, roomId: booking.roomId });

  res.json({ success: true, message: `Booking ${booking.id} cancelled. Dates released.` });
});

// 6. DELETE Booking
app.delete('/api/bookings/:id', (req, res) => {
  const bookingId = req.params.id;
  const idx = dbState.bookings.findIndex(b => b.id === bookingId);

  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'Booking not found.' });
  }

  const [deleted] = dbState.bookings.splice(idx, 1);
  persistState();

  broadcast('booking_deleted', { bookingId, roomId: deleted.roomId, property: deleted.property });
  broadcast('availability_updated', { property: deleted.property, roomId: deleted.roomId });

  res.json({ success: true, message: `Booking ${bookingId} deleted.` });
});

/* =========================================================
   iCAL ENDPOINTS (EXPORT & IMPORT URL MANAGEMENT)
========================================================= */

// Export iCal (.ics) Calendar Feed Endpoint
app.get(['/api/ical/export/:property.ics', '/api/ical/export/:property/:platform.ics'], (req, res) => {
  const { property, platform } = req.params;
  const bks = (dbState.bookings || []).filter(b => b.property === property && !['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED'].includes(b.status));
  const maints = (dbState.maintenance || []).filter(m => m.property === property && m.status !== 'completed');

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Azure Hospitality//iCal Calendar Feed Engine//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:Azure Hospitality - ${property.toUpperCase()} ${platform ? '('+platform.toUpperCase()+')' : ''}`
  ];

  for (const b of bks) {
    const dtStart = b.checkIn.replace(/-/g, '') + 'T130000Z';
    const dtEnd = b.checkOut.replace(/-/g, '') + 'T110000Z';
    ics.push('BEGIN:VEVENT');
    ics.push(`UID:${b.id}@azurehospitality.in`);
    ics.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`);
    ics.push(`DTSTART:${dtStart}`);
    ics.push(`DTEND:${dtEnd}`);
    ics.push(`SUMMARY:Reserved - ${b.guestName} (${b.source})`);
    ics.push(`DESCRIPTION:Azure Hospitality Reservation ${b.id} for Room ${b.roomId}`);
    ics.push('STATUS:CONFIRMED');
    ics.push('END:VEVENT');
  }

  for (const m of maints) {
    const mStart = (m.startDate || m.date || '2026-01-01').replace(/-/g, '') + 'T000000Z';
    const mEnd = (m.endDate || addDaysStr(m.startDate || todayStr(), 1)).replace(/-/g, '') + 'T235959Z';
    ics.push('BEGIN:VEVENT');
    ics.push(`UID:${m.id}@azurehospitality.in`);
    ics.push(`DTSTART:${mStart}`);
    ics.push(`DTEND:${mEnd}`);
    ics.push(`SUMMARY:Blocked - ${m.reason || 'Maintenance'}`);
    ics.push(`DESCRIPTION:Room ${m.roomId} Blocked for Maintenance`);
    ics.push('STATUS:CONFIRMED');
    ics.push('END:VEVENT');
  }

  ics.push('END:VCALENDAR');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${property}-${platform || 'calendar'}.ics"`);
  res.send(ics.join('\r\n'));
});

// Configure iCal Import URL for Property & Platform
app.post('/api/ical/configure', (req, res) => {
  const property = req.body.property;
  const platform = req.body.platform;
  const importUrl = req.body.importUrl || req.body.icalImportUrl || '';

  if (!property || !platform) {
    return res.status(400).json({ success: false, message: 'Property and Platform are required.' });
  }

  const key = `${property}|${platform}`;
  let feed = dbState.ota[key];

  const baseUrl = getBaseUrl(req);
  if (!feed) {
    const slug = platform.toLowerCase().replace(/[^a-z0-9]/g, '');
    feed = {
      property,
      platform,
      status: 'not_configured',
      importUrl: '',
      exportUrl: `${baseUrl}/api/ical/export/${property}/${slug}.ics`,
      lastSync: null,
      lastSyncAttempt: null,
      lastError: null
    };
    dbState.ota[key] = feed;
  }
  feed.exportUrl = `${baseUrl}/api/ical/export/${property}/${platform.toLowerCase().replace(/[^a-z0-9]/g, '')}.ics`;


  feed.importUrl = (importUrl || '').trim();
  feed.status = feed.importUrl ? 'configured' : 'not_configured';
  feed.lastSyncAttempt = new Date().toISOString();

  logOtaEvent(property, platform, 'ICAL_CONFIG', `Updated iCal import URL: ${feed.importUrl ? feed.importUrl : 'Cleared'}`, 'Success');

  persistState();

  broadcast('ical_configured', { key, feed });
  res.json({ success: true, message: `iCal feed configured for ${platform} (${property}). Status: ${feed.status}`, feed });
});


// Manual Sync Single iCal Feed
app.post('/api/ical/sync-single', async (req, res) => {
  const { property, platform, key } = req.body;
  const targetKey = key || `${property}|${platform}`;
  const feed = dbState.ota[targetKey];

  if (!feed) {
    return res.status(404).json({ success: false, message: 'iCal Feed configuration not found.' });
  }

  if (!feed.importUrl) {
    return res.status(400).json({ success: false, message: 'Please enter an Import iCal Feed URL first.' });
  }

  try {
    const result = await syncIcalFeed(feed.property, feed.platform, feed.importUrl);
    res.json({ success: true, message: `Successfully synced ${feed.platform} iCal feed. Imported ${result.importedCount} event(s).`, result });
  } catch (err) {
    res.status(500).json({ success: false, message: `iCal Sync failed: ${err.message}` });
  }
});

// Manual Sync All iCal Feeds
app.post('/api/ical/sync-all', async (req, res) => {
  const configuredKeys = Object.keys(dbState.ota || {}).filter(k => dbState.ota[k] && dbState.ota[k].importUrl);

  if (configuredKeys.length === 0) {
    return res.json({ success: true, message: 'No import iCal URLs configured yet. Please enter import URLs for your channels.' });
  }

  const results = [];
  for (const k of configuredKeys) {
    const feed = dbState.ota[k];
    try {
      const resVal = await syncIcalFeed(feed.property, feed.platform, feed.importUrl);
      results.push({ key: k, status: 'Success', imported: resVal.importedCount });
    } catch (e) {
      results.push({ key: k, status: 'Failed', error: e.message });
    }
  }

  res.json({ success: true, message: `Synchronized ${results.length} configured iCal feed(s).`, results });
});

// Conflict resolution
app.post('/api/ota/conflicts/:id/resolve', async (req, res) => {
  const conflictId = req.params.id;
  const { action, newRoomId, resolvedBy } = req.body;

  const conflict = (dbState.otaConflicts || []).find(c => c.id === conflictId);
  if (!conflict) {
    return res.status(404).json({ success: false, message: 'Conflict record not found.' });
  }

  if (action === 'reassign') {
    if (!newRoomId) return res.status(400).json({ success: false, message: 'New room ID required for reassign.' });
    
    const inc = conflict.incomingBooking;
    const bookingId = 'BK-ICAL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const newBooking = {
      id: bookingId,
      property: conflict.property,
      roomId: newRoomId,
      guestName: inc.guestName,
      mobile: inc.mobile,
      email: inc.email || '',
      adults: 2,
      children: 0,
      checkIn: inc.checkIn,
      checkInTime: '13:00',
      checkOut: inc.checkOut,
      checkOutTime: '11:00',
      rate: inc.rate,
      discount: 0,
      advance: inc.rate,
      source: conflict.platform.toUpperCase(),
      status: 'confirmed',
      payment: 'paid',
      otaSyncStatus: 'SYNCED',
      notes: `Reassigned from conflict with room ${conflict.roomId}`,
      createdBy: resolvedBy || 'Admin',
      createdDate: todayStr()
    };

    dbState.bookings.push(newBooking);
    conflict.status = 'RESOLVED_REASSIGNED';
    conflict.resolutionDetails = `Reassigned to Room ${newRoomId}`;

    broadcast('booking_created', { booking: newBooking });
  } else if (action === 'override') {
    if (conflict.existingBooking) {
      const existing = dbState.bookings.find(b => b.id === conflict.existingBooking.id);
      if (existing) existing.status = 'cancelled';
    }

    const inc = conflict.incomingBooking;
    const bookingId = 'BK-ICAL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const newBooking = {
      id: bookingId,
      property: conflict.property,
      roomId: conflict.roomId,
      guestName: inc.guestName,
      mobile: inc.mobile,
      email: inc.email || '',
      adults: 2,
      children: 0,
      checkIn: inc.checkIn,
      checkInTime: '13:00',
      checkOut: inc.checkOut,
      checkOutTime: '11:00',
      rate: inc.rate,
      discount: 0,
      advance: inc.rate,
      source: conflict.platform.toUpperCase(),
      status: 'confirmed',
      payment: 'paid',
      otaSyncStatus: 'SYNCED',
      notes: 'Conflict overridden by admin',
      createdBy: resolvedBy || 'Admin',
      createdDate: todayStr()
    };

    dbState.bookings.push(newBooking);
    conflict.status = 'RESOLVED_OVERRIDDEN';
    conflict.resolutionDetails = `Offline booking cancelled, iCal booking accepted for Room ${conflict.roomId}`;

    broadcast('booking_created', { booking: newBooking });
  } else if (action === 'reject') {
    conflict.status = 'RESOLVED_REJECTED';
    conflict.resolutionDetails = `Rejected incoming iCal event from ${conflict.platform}.`;
  }

  persistState();

  broadcast('ota_conflict_resolved', { conflict });
  broadcast('availability_updated', { property: conflict.property });

  res.json({ success: true, message: `Conflict ${conflictId} resolved (${action}).`, conflict });
});

app.get('/api/ota/logs', (req, res) => {
  res.json({ success: true, logs: dbState.otaSyncLogs || [] });
});

app.delete('/api/ota/logs', (req, res) => {
  dbState.otaSyncLogs = [];
  persistState();
  res.json({ success: true, message: 'Sync logs cleared.' });
});

// Clear All OTA Conflict Alerts
app.delete('/api/ota/conflicts', (req, res) => {
  dbState.otaConflicts = [];
  persistState();
  broadcast('ota_conflicts_cleared', {});
  res.json({ success: true, message: 'All OTA conflict alerts cleared successfully.' });
});


// Instant Fetch All Online Bookings Endpoint
app.post('/api/ota/fetch-online', async (req, res) => {
  const configuredKeys = Object.keys(dbState.ota || {}).filter(k => dbState.ota[k] && dbState.ota[k].importUrl);

  if (configuredKeys.length === 0) {
    return res.json({ success: true, message: 'No online iCal import URLs configured. Please add your OTA calendar URLs first.' });
  }

  let totalImported = 0;
  let totalConflicts = 0;
  const syncResults = [];

  for (const k of configuredKeys) {
    const feed = dbState.ota[k];
    try {
      const resVal = await syncIcalFeed(feed.property, feed.platform, feed.importUrl);
      totalImported += resVal.importedCount;
      totalConflicts += resVal.conflictCount;
      syncResults.push({ platform: feed.platform, property: feed.property, status: 'Success', imported: resVal.importedCount, conflicts: resVal.conflictCount });
    } catch (e) {
      syncResults.push({ platform: feed.platform, property: feed.property, status: 'Failed', error: e.message });
    }
  }

  res.json({
    success: true,
    message: `Online fetch complete! Imported ${totalImported} new online booking(s) across ${syncResults.length} channel(s).`,
    totalImported,
    totalConflicts,
    details: syncResults
  });
});

// Real-Time Webhook & Direct Push Endpoint for Incoming Online Bookings
app.post(['/api/ota/webhook', '/api/online-booking/push'], async (req, res) => {
  const { property = 'azurevista', platform = 'Online', bookingReference, guestName, mobile, email, checkIn, checkOut, rate, totalAmount, paidAmount, roomType, notes } = req.body;

  if (!checkIn || !checkOut || !guestName) {
    return res.status(400).json({ success: false, message: 'Missing required online booking payload fields: guestName, checkIn, checkOut.' });
  }

  const roomsList = property === 'azurevista' ? dbState.rooms : dbState.units;
  const externalUid = bookingReference || `ONLINE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // Check if booking already exists
  const existing = dbState.bookings.find(b => b.externalUid === externalUid);
  if (existing) {
    return res.json({ success: true, message: 'Online booking already registered.', booking: existing });
  }

  let targetRoomId = null;
  for (const r of roomsList) {
    const check = validateBookingOverlap(r.id, checkIn, checkOut);
    if (check.valid) {
      targetRoomId = r.id;
      break;
    }
  }

  if (!targetRoomId) {
    const conflictItem = {
      id: 'CONF-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      property,
      roomId: roomsList[0]?.id || 'RM-101',
      platform,
      incomingBooking: { guestName, mobile, email, checkIn, checkOut, rate: rate || totalAmount || 3500 },
      existingBooking: null,
      reason: `Webhook Alert: All rooms at ${property} occupied for ${checkIn} → ${checkOut}`,
      status: 'UNRESOLVED',
      createdAt: new Date().toISOString()
    };
    if (!dbState.otaConflicts) dbState.otaConflicts = [];
    dbState.otaConflicts.unshift(conflictItem);
    broadcast('ota_conflict', { conflict: conflictItem });
    return res.status(409).json({ success: false, message: 'All rooms occupied during requested dates. Recorded conflict for staff review.', conflict: conflictItem });
  }

  await acquireRoomLock(targetRoomId);
  try {
    const newBooking = {
      id: 'BK-ONLINE-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      externalUid,
      property,
      roomId: targetRoomId,
      guestName,
      mobile: mobile || `+91${Math.floor(6000000000 + Math.random() * 3999999999)}`,
      email: email || '',
      adults: 2,
      children: 0,
      checkIn,
      checkInTime: '13:00',
      checkOut,
      checkOutTime: '11:00',
      rate: Number(rate || totalAmount || 3500),
      discount: 0,
      advance: Number(paidAmount || totalAmount || rate || 3500),
      source: platform.toUpperCase(),
      status: 'confirmed',
      payment: 'paid',
      otaSyncStatus: 'SYNCED',
      notes: notes || `Direct webhook online booking from ${platform}`,
      createdBy: `${platform} Webhook`,
      createdDate: todayStr()
    };

    dbState.bookings.push(newBooking);

    // Payments & Guest profile
    let guest = dbState.guests.find(g => g.mobile === newBooking.mobile);
    if (!guest) {
      dbState.guests.push({
        id: 'GU-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        name: guestName,
        mobile: newBooking.mobile,
        email: email || '',
        address: 'Online Booking Webhook',
        idType: 'OTA Webhook',
        idNumber: externalUid,
        visits: 1,
        lastVisit: todayStr()
      });
    }

    dbState.payments.push({
      id: 'PM-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      bookingId: newBooking.id,
      property,
      amount: newBooking.advance,
      method: 'Online Webhook Payment',
      date: todayStr(),
      notes: `Webhook payment from ${platform}`,
      addedBy: `${platform} Webhook`
    });

    logOtaEvent(property, platform, 'WEBHOOK_PUSH', `Received online booking ${externalUid} for ${guestName}`, 'Success');
    persistState();

    broadcast('booking_created', { booking: newBooking });
    broadcast('availability_updated', { property });

    res.json({ success: true, message: `Online booking ${newBooking.id} automatically created and assigned to room ${targetRoomId}.`, booking: newBooking });
  } finally {
    releaseRoomLock(targetRoomId);
  }
});

// Automated High-Frequency Background Online Poller (Every 2 Minutes)
setInterval(async () => {
  try {
    const configuredKeys = Object.keys(dbState.ota || {}).filter(k => dbState.ota[k] && dbState.ota[k].importUrl && dbState.ota[k].autoSync !== false);
    if (configuredKeys.length > 0) {
      for (const key of configuredKeys) {
        const feed = dbState.ota[key];
        try {
          await syncIcalFeed(feed.property, feed.platform, feed.importUrl);
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('[Auto OTA Poller] Error:', err.message);
  }
}, 2 * 60 * 1000);


/* =========================================================
   STATIC ASSET & SPA ROUTING
========================================================= */

app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* =========================================================
   BACKGROUND CRON SCHEDULE (Every 10 Minutes for iCal Sync)
========================================================= */
cron.schedule('*/10 * * * *', async () => {
  console.log('[Cron] Running background iCal Calendar Feed sync for configured channels...');
  const configuredKeys = Object.keys(dbState.ota || {}).filter(k => dbState.ota[k] && dbState.ota[k].importUrl);
  for (const k of configuredKeys) {
    const feed = dbState.ota[k];
    try {
      await syncIcalFeed(feed.property, feed.platform, feed.importUrl);
    } catch (e) {}
  }
});

/* =========================================================
   START SERVER
========================================================= */
initDatabase().then(() => {
  if (process.env.VERCEL) {
    console.log('Running on Vercel Serverless Platform');
  } else {
    server.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(` AZURE HOSPITALITY CENTRAL PMS SERVER IS LIVE! `);
      console.log(` Port: ${PORT}`);
      console.log(` HTTP API: http://localhost:${PORT}/api/state`);
      console.log(` Sync Mode: Manual & Automated iCal (.ics) Calendar Feed Sync`);
      console.log(` Real-time WebSocket: ws://localhost:${PORT}/ws`);
      console.log(` Single Source of Truth DB: ${isMongoConnected ? 'MongoDB Cloud Database' : 'File-Backed Central Store'}`);
      console.log(`=======================================================`);
    });
  }
});

module.exports = app;

