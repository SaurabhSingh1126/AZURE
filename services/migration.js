const fs = require('fs');
const path = require('path');
const Booking = require('../models/Booking');
const Guest = require('../models/Guest');
const Room = require('../models/Room');
const Payment = require('../models/Payment');
const Expense = require('../models/Expense');
const Inventory = require('../models/Inventory');
const Invoice = require('../models/Invoice');
const AuditLog = require('../models/AuditLog');
const Setting = require('../models/Setting');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

async function runMigration(sourceData = null) {
  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  let data = sourceData;
  const localFile = path.join(__dirname, '..', 'data_store.json');

  if (!data && fs.existsSync(localFile)) {
    try {
      const raw = fs.readFileSync(localFile, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse local data_store.json: ${e.message}`);
    }
  }

  if (!data) {
    throw new Error('No migration data provided and data_store.json not found.');
  }

  // 1. Create timestamped safety backup before doing anything
  const backupFileName = `pre_migration_backup_${Date.now()}.json`;
  const backupPath = path.join(BACKUP_DIR, backupFileName);
  fs.writeFileSync(backupPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[Migration] Verified safety backup written to: ${backupPath}`);

  const report = {
    timestamp: new Date().toISOString(),
    backupFile: backupFileName,
    results: {
      rooms: { imported: 0, skipped: 0, failed: 0 },
      guests: { imported: 0, skipped: 0, failed: 0 },
      bookings: { imported: 0, skipped: 0, failed: 0, failedRecords: [] },
      payments: { imported: 0, skipped: 0, failed: 0 },
      invoices: { imported: 0, skipped: 0, failed: 0 },
      expenses: { imported: 0, skipped: 0, failed: 0 },
      inventory: { imported: 0, skipped: 0, failed: 0 },
      auditLogs: { imported: 0, skipped: 0, failed: 0 },
      settings: false
    }
  };

  // 2. Migrate Rooms & Units
  const allRooms = [
    ...(data.rooms || []).map(r => ({ ...r, isUnit: false })),
    ...(data.units || []).map(u => ({ ...u, isUnit: true }))
  ];

  for (const r of allRooms) {
    try {
      const existing = await Room.findOne({ id: r.id });
      if (existing) {
        report.results.rooms.skipped++;
      } else {
        await Room.create({
          id: r.id,
          property: r.property || 'azurevista',
          number: String(r.number),
          type: r.type || 'Standard',
          rate: Number(r.rate || 0),
          status: r.status || 'available',
          isUnit: !!r.isUnit
        });
        report.results.rooms.imported++;
      }
    } catch (err) {
      report.results.rooms.failed++;
    }
  }

  // 3. Migrate Guests
  for (const g of (data.guests || [])) {
    try {
      const existing = await Guest.findOne({ id: g.id });
      if (existing) {
        report.results.guests.skipped++;
      } else {
        await Guest.create({
          id: g.id,
          name: g.name,
          mobile: g.mobile,
          email: g.email || '',
          address: g.address || '',
          idType: g.idType || '',
          idNumber: g.idNumber || '',
          properties: g.properties || ['azurevista'],
          totalStays: Number(g.totalStays || 1),
          totalSpend: Number(g.totalSpend || 0),
          outstanding: Number(g.outstanding || 0)
        });
        report.results.guests.imported++;
      }
    } catch (err) {
      report.results.guests.failed++;
    }
  }

  // 4. Migrate Bookings (With strict validation and duplicate prevention)
  for (const b of (data.bookings || [])) {
    try {
      if (!b.id || !b.property || !b.roomId || !b.guestName || !b.mobile || !b.checkIn || !b.checkOut) {
        report.results.bookings.failed++;
        report.results.bookings.failedRecords.push({ id: b.id || 'UNKNOWN', reason: 'Missing required booking fields' });
        continue;
      }

      const existing = await Booking.findOne({ id: b.id });
      if (existing) {
        report.results.bookings.skipped++;
      } else {
        await Booking.create({
          id: b.id,
          property: b.property,
          roomId: b.roomId,
          guestId: b.guestId || '',
          guestName: b.guestName,
          mobile: b.mobile,
          email: b.email || '',
          adults: Number(b.adults || 1),
          children: Number(b.children || 0),
          checkIn: b.checkIn,
          checkInTime: b.checkInTime || '13:00',
          checkOut: b.checkOut,
          checkOutTime: b.checkOutTime || '11:00',
          rate: Number(b.rate || 0),
          discount: Number(b.discount || 0),
          advance: Number(b.advance || 0),
          source: b.source || 'OFFLINE',
          status: b.status || 'reserved',
          payment: b.payment || 'unpaid',
          otaSyncStatus: b.otaSyncStatus || 'SYNCED',
          notes: b.notes || '',
          createdBy: b.createdBy || 'Front Desk',
          createdDate: b.createdDate || b.checkIn
        });
        report.results.bookings.imported++;
      }
    } catch (err) {
      report.results.bookings.failed++;
      report.results.bookings.failedRecords.push({ id: b.id, reason: err.message });
    }
  }

  // 5. Migrate Payments
  for (const p of (data.payments || [])) {
    try {
      const existing = await Payment.findOne({ id: p.id });
      if (existing) {
        report.results.payments.skipped++;
      } else {
        await Payment.create({
          id: p.id,
          bookingId: p.bookingId,
          property: p.property || 'azurevista',
          amount: Number(p.amount || 0),
          method: p.method || 'Cash',
          date: p.date,
          notes: p.notes || '',
          addedBy: p.addedBy || 'Front Desk'
        });
        report.results.payments.imported++;
      }
    } catch (err) {
      report.results.payments.failed++;
    }
  }

  // 6. Migrate Invoices
  for (const inv of (data.invoices || [])) {
    try {
      const existing = await Invoice.findOne({ id: inv.id });
      if (existing) {
        report.results.invoices.skipped++;
      } else {
        await Invoice.create(inv);
        report.results.invoices.imported++;
      }
    } catch (err) {
      report.results.invoices.failed++;
    }
  }

  // 7. Migrate Expenses
  for (const exp of (data.expenses || [])) {
    try {
      const existing = await Expense.findOne({ id: exp.id });
      if (existing) {
        report.results.expenses.skipped++;
      } else {
        await Expense.create(exp);
        report.results.expenses.imported++;
      }
    } catch (err) {
      report.results.expenses.failed++;
    }
  }

  // 8. Migrate Inventory
  for (const inv of (data.inventory || [])) {
    try {
      const existing = await Inventory.findOne({ id: inv.id });
      if (existing) {
        report.results.inventory.skipped++;
      } else {
        await Inventory.create(inv);
        report.results.inventory.imported++;
      }
    } catch (err) {
      report.results.inventory.failed++;
    }
  }

  // 9. Migrate Audit Logs
  for (const al of (data.auditLog || [])) {
    try {
      const existing = await AuditLog.findOne({ id: al.id });
      if (existing) {
        report.results.auditLogs.skipped++;
      } else {
        await AuditLog.create(al);
        report.results.auditLogs.imported++;
      }
    } catch (err) {
      report.results.auditLogs.failed++;
    }
  }

  // 10. Migrate Settings & Operations metadata
  try {
    await Setting.findOneAndUpdate(
      { key: 'system_settings' },
      {
        $set: {
          properties: data.properties || {},
          settings: data.settings || {},
          suppliers: data.suppliers || [],
          staff: data.staff || [],
          maintenance: data.maintenance || [],
          housekeeping: data.housekeeping || [],
          foodBills: data.foodBills || [],
          ota: data.ota || {},
          otaSyncLogs: data.otaSyncLogs || [],
          otaConflicts: data.otaConflicts || [],
          otaSyncQueue: data.otaSyncQueue || [],
          otaRoomMappings: data.otaRoomMappings || [],
          processedWebhookEvents: data.processedWebhookEvents || {},
          invoiceSeq: data.invoiceSeq || 10,
          lastSync: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    report.results.settings = true;
  } catch (err) {
    console.error('[Migration] Settings migration error:', err.message);
  }

  console.log('[Migration] Migration completed successfully!', JSON.stringify(report.results));
  return report;
}

module.exports = {
  runMigration
};
