const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Guest = require('../models/Guest');
const Room = require('../models/Room');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const AuditLog = require('../models/AuditLog');
const Setting = require('../models/Setting');
const { broadcast } = require('../services/realtime');
const { optionalAuth, requireRole } = require('../middleware/auth');
const { updateStore, getStore } = require('../services/storeSync');

// Mutex locks for atomic double-booking prevention
const roomLocks = new Map();

async function acquireRoomLock(roomId) {
  while (roomLocks.get(roomId)) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  roomLocks.set(roomId, true);
}

function releaseRoomLock(roomId) {
  roomLocks.delete(roomId);
}

function isDateOverlapping(start1, end1, start2, end2) {
  return (start1 < end2 && end1 > start2);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const OTA_SOURCES = ['Airbnb', 'MakeMyTrip', 'Goibibo', 'Booking.com', 'Agoda', 'Expedia', 'Other OTA'];

// 1. GET /api/bookings — Retrieve bookings with server-side pagination & filters
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    let limit = parseInt(req.query.limit) || 25;
    if (req.query.limit === 'all' || req.query.limit === '-1') {
      limit = 10000;
    } else {
      limit = Math.min(10000, Math.max(1, limit));
    }

    const {
      search, q,
      property,
      status,
      source,
      roomId,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Fallback if Mongoose is offline / serverless cold-start without Atlas
    if (mongoose.connection.readyState !== 1) {
      const dataStorePath = path.join(__dirname, '..', 'data_store.json');
      if (fs.existsSync(dataStorePath)) {
        try {
          const store = JSON.parse(fs.readFileSync(dataStorePath, 'utf8'));
          let list = store.bookings || [];
          if (property && property !== 'all') list = list.filter(b => b.property === property);
          if (status && status !== 'all') list = list.filter(b => b.status === status);
          if (roomId && roomId !== 'all') list = list.filter(b => b.roomId === roomId);
          if (source && source !== 'all') list = list.filter(b => b.source === source);
          return res.json({
            success: true,
            bookings: list,
            pagination: {
              total: list.length,
              page: 1,
              limit: list.length,
              totalPages: 1,
              hasPrev: false,
              hasNext: false
            }
          });
        } catch (e) {
          console.warn('[Bookings Data Store Fallback Error]:', e.message);
        }
      }
    }

    const filter = {};

    // Property filter
    if (property && property !== 'all') {
      filter.property = property;
    }

    // Status filter
    if (status && status !== 'all') {
      filter.status = status;
    }

    // Payment status filter
    const payment = req.query.payment;
    if (payment && payment !== 'all') {
      if (payment === 'pending' || payment === 'unpaid') {
        filter.payment = { $in: ['partial', 'unpaid'] };
      } else {
        filter.payment = payment;
      }
    }

    // Source filter
    if (source && source !== 'all') {
      if (source === 'OTA') {
        filter.source = { $in: OTA_SOURCES };
      } else {
        filter.source = source;
      }
    }

    // Room ID filter
    if (roomId && roomId !== 'all') {
      filter.roomId = roomId;
    }

    // Date range filter
    if (startDate && endDate) {
      filter.checkIn = { $lte: endDate };
      filter.checkOut = { $gte: startDate };
    } else if (startDate) {
      filter.checkIn = { $gte: startDate };
    } else if (endDate) {
      filter.checkOut = { $lte: endDate };
    }

    // Multi-field search
    const searchQuery = search || q;
    if (searchQuery && searchQuery.trim()) {
      const term = searchQuery.trim();
      const regex = new RegExp(term, 'i');
      filter.$or = [
        { guestName: regex },
        { mobile: regex },
        { id: regex },
        { email: regex }
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      Booking.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      success: true,
      bookings,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. GET /api/bookings/:id — Get single booking details
router.get('/:id', async (req, res) => {
  try {
    const booking = await Booking.findOne({ id: req.params.id }).lean();
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    const [payments, invoices, guest, settingsDoc] = await Promise.all([
      Payment.find({ bookingId: booking.id }).lean(),
      Invoice.find({ bookingId: booking.id }).lean(),
      Guest.findOne({ id: booking.guestId }).lean(),
      Setting.findOne({ key: 'system_settings' }).lean()
    ]);

    const foodBills = (settingsDoc?.foodBills || []).filter(fb => fb.bookingId === booking.id);

    res.json({
      success: true,
      booking,
      guest,
      payments,
      invoices,
      foodBills
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. POST /api/bookings — Create booking with atomic date overlap validation
router.post('/', optionalAuth, async (req, res) => {
  const {
    property, roomId, guestName, mobile, email,
    adults, children, checkIn, checkOut, rate,
    discount, advance, source, notes, createdBy, customId
  } = req.body;

  if (!property || !roomId || !guestName || !mobile || !checkIn || !checkOut) {
    return res.status(400).json({
      success: false,
      message: 'Missing required booking fields: property, roomId, guestName, mobile, checkIn, checkOut.'
    });
  }

  if (new Date(checkOut) <= new Date(checkIn)) {
    return res.status(400).json({
      success: false,
      message: 'Check-out date must be strictly after check-in date.'
    });
  }

  // Acquire atomic room lock to prevent simultaneous race conditions
  await acquireRoomLock(roomId);

  try {
    const bookingId = customId || ('BK-' + Math.random().toString(36).slice(2, 8).toUpperCase());
    const today = todayStr();
    const advAmount = Number(advance || 0);
    const rateAmount = Number(rate || 0);
    const discAmount = Number(discount || 0);
    const initialStatus = checkIn <= today ? 'confirmed' : 'reserved';
    const initialPayment = advAmount > 0 ? (advAmount >= rateAmount ? 'paid' : 'partial') : 'unpaid';

    // 1. If MongoDB is connected:
    if (mongoose.connection.readyState === 1) {
      // Check overlapping bookings in MongoDB
      const activeConflicts = await Booking.find({
        roomId,
        status: { $nin: ['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED', 'Checked-out', 'Checked-Out', 'Cancelled', 'No-show'] },
        $or: [
          {
            checkIn: { $lt: checkOut },
            checkOut: { $gt: checkIn }
          }
        ]
      }).lean();

      if (activeConflicts.length > 0) {
        const conflict = activeConflicts[0];
        return res.status(400).json({
          success: false,
          conflictBookingId: conflict.id,
          message: `Room ${roomId} is already booked for selected dates (${conflict.checkIn} → ${conflict.checkOut}) by ${conflict.guestName} [${conflict.id}].`
        });
      }

      // Check maintenance blocks
      const settingsDoc = await Setting.findOne({ key: 'system_settings' }).lean();
      const maintenanceBlocks = (settingsDoc?.maintenance || []).filter(m => {
        if (m.roomId !== roomId) return false;
        if (m.status === 'completed' || m.status === 'resolved') return false;
        const mStart = m.startDate || m.date || '2000-01-01';
        const mEnd = m.endDate || mStart;
        return isDateOverlapping(mStart, mEnd, checkIn, checkOut);
      });

      if (maintenanceBlocks.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Room ${roomId} is currently blocked for maintenance: ${maintenanceBlocks[0].reason || 'Maintenance'}.`
        });
      }

      // Create or update guest in MongoDB
      let guest = await Guest.findOne({ mobile: mobile.trim() });
      if (!guest) {
        guest = await Guest.create({
          id: 'GU-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          name: guestName.trim(),
          mobile: mobile.trim(),
          email: (email || '').trim(),
          address: '',
          idType: '',
          idNumber: '',
          properties: [property],
          totalStays: 1,
          totalSpend: Number(advAmount),
          outstanding: 0
        });
      } else {
        guest.totalStays = (guest.totalStays || 0) + 1;
        guest.totalSpend = (guest.totalSpend || 0) + Number(advAmount);
        if (!guest.properties.includes(property)) guest.properties.push(property);
        await guest.save();
      }

      const newBooking = await Booking.create({
        id: bookingId,
        property,
        roomId,
        guestId: guest.id,
        guestName: guestName.trim(),
        mobile: mobile.trim(),
        email: (email || '').trim(),
        adults: Number(adults || 1),
        children: Number(children || 0),
        checkIn,
        checkInTime: '13:00',
        checkOut,
        checkOutTime: '11:00',
        rate: rateAmount,
        discount: discAmount,
        advance: advAmount,
        source: source || 'OFFLINE',
        status: initialStatus,
        payment: initialPayment,
        otaSyncStatus: 'SYNCED',
        notes: notes || '',
        createdBy: createdBy || req.user?.name || 'Front Desk',
        createdDate: today
      });

      // Record advance payment if present
      if (advAmount > 0) {
        await Payment.create({
          id: 'TXN-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          bookingId: newBooking.id,
          property: newBooking.property,
          amount: advAmount,
          method: 'Cash',
          date: today,
          notes: 'Advance payment',
          addedBy: createdBy || req.user?.name || 'Front Desk'
        }).catch(() => {});
      }

      // Update room status if checking in today
      if (checkIn === today) {
        await Room.findOneAndUpdate(
          { id: roomId },
          { status: 'reserved' }
        ).catch(() => {});
      }

      // Record audit log
      await AuditLog.create({
        id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        user: createdBy || req.user?.name || 'Front Desk',
        action: 'Booking Created',
        property,
        roomId,
        record: newBooking.id,
        date: new Date().toISOString()
      }).catch(() => {});

      // Keep local data_store.json synchronously updated
      updateStore(store => {
        if (!store.bookings) store.bookings = [];
        const plain = newBooking.toObject ? newBooking.toObject() : newBooking;
        store.bookings.unshift(plain);
      });

      // Broadcast multi-device real-time event
      broadcast('booking_created', { booking: newBooking });
      broadcast('availability_updated', { property, roomId, checkIn, checkOut });

      return res.status(201).json({
        success: true,
        message: `Booking ${newBooking.id} created and synchronized across all devices.`,
        booking: newBooking
      });
    }

    // 2. Offline / Serverless fallback (data_store.json)
    const store = getStore();
    const activeConflicts = (store.bookings || []).filter(b => {
      if (b.roomId !== roomId) return false;
      const st = (b.status || '').toLowerCase();
      if (['cancelled', 'checked-out', 'no-show', 'rejected'].includes(st)) return false;
      return (b.checkIn < checkOut && b.checkOut > checkIn);
    });

    if (activeConflicts.length > 0) {
      const conflict = activeConflicts[0];
      return res.status(400).json({
        success: false,
        conflictBookingId: conflict.id,
        message: `Room ${roomId} is already booked for selected dates (${conflict.checkIn} → ${conflict.checkOut}) by ${conflict.guestName} [${conflict.id}].`
      });
    }

    const fallbackBooking = {
      id: bookingId,
      property,
      roomId,
      guestId: 'GU-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      guestName: guestName.trim(),
      mobile: mobile.trim(),
      email: (email || '').trim(),
      adults: Number(adults || 1),
      children: Number(children || 0),
      checkIn,
      checkInTime: '13:00',
      checkOut,
      checkOutTime: '11:00',
      rate: rateAmount,
      discount: discAmount,
      advance: advAmount,
      source: source || 'OFFLINE',
      status: initialStatus,
      payment: initialPayment,
      otaSyncStatus: 'SYNCED',
      notes: notes || '',
      createdBy: createdBy || req.user?.name || 'Front Desk',
      createdDate: today
    };

    updateStore(s => {
      if (!s.bookings) s.bookings = [];
      s.bookings.unshift(fallbackBooking);
    });

    broadcast('booking_created', { booking: fallbackBooking });
    broadcast('availability_updated', { property, roomId, checkIn, checkOut });

    return res.status(201).json({
      success: true,
      message: `Booking ${fallbackBooking.id} created and saved to local data store.`,
      booking: fallbackBooking
    });
  } catch (err) {
    console.error('[Create Booking Error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    releaseRoomLock(roomId);
  }
});

// 4. PATCH & PUT /api/bookings/:id — Update booking with overlap validation
const handleUpdateBooking = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const {
      roomId, checkIn, checkOut, guestName, mobile, email,
      adults, children, rate, discount, advance, status, source, notes
    } = req.body;

    if (mongoose.connection.readyState === 1) {
      const booking = await Booking.findOne({ id: bookingId });
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found.' });
      }

      const targetRoomId = roomId || booking.roomId;
      const targetCheckIn = checkIn || booking.checkIn;
      const targetCheckOut = checkOut || booking.checkOut;

      // If room or dates changed, re-validate overlap
      if (targetRoomId !== booking.roomId || targetCheckIn !== booking.checkIn || targetCheckOut !== booking.checkOut) {
        await acquireRoomLock(targetRoomId);
        try {
          const activeConflicts = await Booking.find({
            id: { $ne: booking.id },
            roomId: targetRoomId,
            status: { $nin: ['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED', 'Checked-out', 'Checked-Out', 'Cancelled', 'No-show'] },
            $or: [
              {
                checkIn: { $lt: targetCheckOut },
                checkOut: { $gt: targetCheckIn }
              }
            ]
          }).lean();

          if (activeConflicts.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Cannot move booking: Room ${targetRoomId} is already booked from ${activeConflicts[0].checkIn} to ${activeConflicts[0].checkOut} by ${activeConflicts[0].guestName} [${activeConflicts[0].id}].`
            });
          }
        } finally {
          releaseRoomLock(targetRoomId);
        }
      }

      if (guestName) booking.guestName = guestName.trim();
      if (mobile) booking.mobile = mobile.trim();
      if (email !== undefined) booking.email = email.trim();
      if (roomId) booking.roomId = roomId;
      if (checkIn) booking.checkIn = checkIn;
      if (checkOut) booking.checkOut = checkOut;
      if (adults != null) booking.adults = Number(adults);
      if (children != null) booking.children = Number(children);
      if (rate != null) booking.rate = Number(rate);
      if (discount != null) booking.discount = Number(discount);
      if (advance != null) booking.advance = Number(advance);
      if (status) booking.status = status;
      if (source) booking.source = source;
      if (notes !== undefined) booking.notes = notes;

      await booking.save();

      // Mirror to data_store.json
      updateStore(store => {
        if (!store.bookings) store.bookings = [];
        const idx = store.bookings.findIndex(b => b.id === bookingId);
        if (idx !== -1) {
          store.bookings[idx] = { ...store.bookings[idx], ...(booking.toObject ? booking.toObject() : booking) };
        }
      });

      // Audit log
      await AuditLog.create({
        id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        user: req.user?.name || 'Front Desk',
        action: 'Booking Updated',
        property: booking.property,
        roomId: booking.roomId,
        record: booking.id,
        date: new Date().toISOString()
      }).catch(() => {});

      // Real-time multi-device sync
      broadcast('booking_updated', { booking });
      broadcast('availability_updated', { property: booking.property, roomId: booking.roomId });

      return res.json({
        success: true,
        message: `Booking ${booking.id} updated successfully.`,
        booking
      });
    }

    // Offline / data_store fallback
    let updatedBooking = null;
    updateStore(store => {
      if (!store.bookings) store.bookings = [];
      const idx = store.bookings.findIndex(b => b.id === bookingId);
      if (idx !== -1) {
        store.bookings[idx] = { ...store.bookings[idx], ...req.body };
        updatedBooking = store.bookings[idx];
      }
    });

    if (!updatedBooking) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    broadcast('booking_updated', { booking: updatedBooking });
    res.json({ success: true, message: `Booking ${bookingId} updated in local store.`, booking: updatedBooking });
  } catch (err) {
    console.error('[Update Booking Error]:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

router.patch('/:id', optionalAuth, handleUpdateBooking);
router.put('/:id', optionalAuth, handleUpdateBooking);

// 5. PATCH & POST /api/bookings/:id/cancel — Cancel booking & release room dates
const handleCancelBooking = async (req, res) => {
  try {
    const bookingId = req.params.id;

    if (mongoose.connection.readyState === 1) {
      const booking = await Booking.findOne({ id: bookingId });
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found.' });
      }

      booking.status = 'cancelled';
      await booking.save();

      // Release room status if reserved or occupied
      const room = await Room.findOne({ id: booking.roomId });
      if (room && (room.status === 'reserved' || room.status === 'occupied')) {
        room.status = 'available';
        await room.save().catch(() => {});
      }

      // Update in data_store.json
      updateStore(store => {
        if (!store.bookings) store.bookings = [];
        const idx = store.bookings.findIndex(b => b.id === bookingId);
        if (idx !== -1) store.bookings[idx].status = 'cancelled';
      });

      // Audit log
      await AuditLog.create({
        id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        user: req.user?.name || 'Front Desk',
        action: 'Booking Cancelled',
        property: booking.property,
        roomId: booking.roomId,
        record: booking.id,
        date: new Date().toISOString()
      }).catch(() => {});

      // Broadcast cancel event
      broadcast('booking_cancelled', { bookingId: booking.id, roomId: booking.roomId, property: booking.property });
      broadcast('availability_updated', { property: booking.property, roomId: booking.roomId });

      return res.json({
        success: true,
        message: `Booking ${booking.id} cancelled. Room dates released.`,
        booking
      });
    }

    // Offline / data_store fallback
    updateStore(store => {
      if (!store.bookings) store.bookings = [];
      const idx = store.bookings.findIndex(b => b.id === bookingId);
      if (idx !== -1) store.bookings[idx].status = 'cancelled';
    });

    broadcast('booking_cancelled', { bookingId, roomId: '', property: '' });
    res.json({ success: true, message: `Booking ${bookingId} cancelled in store.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

router.patch('/:id/cancel', optionalAuth, handleCancelBooking);
router.post('/:id/cancel', optionalAuth, handleCancelBooking);

// DELETE /api/bookings/all & POST /api/bookings/clear-all — Delete all bookings and transactions
const clearAllHandler = async (req, res) => {
  try {
    const Expense = require('../models/Expense');
    const [bookingRes, paymentRes, expenseRes, invoiceRes] = await Promise.all([
      Booking.deleteMany({}),
      Payment.deleteMany({}),
      Expense.deleteMany({}),
      Invoice.deleteMany({})
    ]);

    // Reset occupied rooms to available
    await Room.updateMany({ status: 'occupied' }, { $set: { status: 'available' } });

    // Clear local data_store.json file
    const fs = require('fs');
    const path = require('path');
    const dataStorePath = path.join(__dirname, '..', 'data_store.json');
    if (fs.existsSync(dataStorePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(dataStorePath, 'utf8'));
        store.bookings = [];
        store.payments = [];
        store.expenses = [];
        store.invoices = [];
        if (store.rooms) {
          store.rooms = store.rooms.map(r => ({ ...r, status: r.status === 'occupied' ? 'available' : r.status }));
        }
        fs.writeFileSync(dataStorePath, JSON.stringify(store, null, 2), 'utf8');
      } catch (e) {}
    }

    await AuditLog.create({
      id: `AUD-${Date.now()}`,
      action: 'DATA_CLEARED',
      user: req.user?.name || 'Admin',
      date: new Date().toISOString(),
      details: `Cleared all bookings (${bookingRes.deletedCount}) and transactions (${paymentRes.deletedCount} payments, ${expenseRes.deletedCount} expenses, ${invoiceRes.deletedCount} invoices)`
    });

    broadcast('bookings_cleared', {
      deletedBookings: bookingRes.deletedCount,
      deletedPayments: paymentRes.deletedCount,
      deletedExpenses: expenseRes.deletedCount,
      deletedInvoices: invoiceRes.deletedCount
    });

    res.json({
      success: true,
      message: 'All bookings and transactions successfully deleted from Central Database.',
      deletedBookings: bookingRes.deletedCount,
      deletedPayments: paymentRes.deletedCount,
      deletedExpenses: expenseRes.deletedCount,
      deletedInvoices: invoiceRes.deletedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

router.delete('/all', optionalAuth, clearAllHandler);
router.post('/clear-all', optionalAuth, clearAllHandler);

// 6. DELETE /api/bookings/:id — Delete booking
router.delete('/:id', optionalAuth, async (req, res) => {
  try {
    const bookingId = req.params.id;

    if (mongoose.connection.readyState === 1) {
      const booking = await Booking.findOneAndDelete({ id: bookingId });
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found.' });
      }

      // Release room
      const room = await Room.findOne({ id: booking.roomId });
      if (room && room.status === 'reserved') {
        room.status = 'available';
        await room.save().catch(() => {});
      }

      updateStore(store => {
        if (store.bookings) {
          store.bookings = store.bookings.filter(b => b.id !== bookingId);
        }
      });

      broadcast('booking_deleted', { bookingId: booking.id, roomId: booking.roomId, property: booking.property });
      broadcast('availability_updated', { property: booking.property, roomId: booking.roomId });

      return res.json({
        success: true,
        message: `Booking ${booking.id} permanently removed.`
      });
    }

    // Offline deletion
    updateStore(store => {
      if (store.bookings) {
        store.bookings = store.bookings.filter(b => b.id !== bookingId);
      }
    });

    broadcast('booking_deleted', { bookingId, roomId: '', property: '' });
    res.json({ success: true, message: `Booking ${bookingId} permanently removed.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. POST /api/bookings/seed-test-data — Fast batch seeder for 10,000 bookings test
router.post('/seed-test-data', optionalAuth, async (req, res) => {
  try {
    const count = parseInt(req.body.count) || 10000;
    const existingTestCount = await Booking.countDocuments({ id: /^BK-TEST-/ });
    if (existingTestCount >= count) {
      const totalBookings = await Booking.countDocuments();
      return res.json({
        success: true,
        message: `Already have ${existingTestCount} test bookings in MongoDB.`,
        totalBookings,
        inserted: 0
      });
    }

    console.log(`[Seeder] Generating ${count} test bookings for scale & pagination verification...`);

    const propertyOptions = ['azurevista', 'azuresuite'];
    const sources = ['Direct', 'OFFLINE', 'Airbnb', 'MakeMyTrip', 'Booking.com'];
    const statuses = ['reserved', 'confirmed', 'checked-in', 'checked-out'];
    const rooms = ['RM-101', 'RM-102', 'RM-103', 'RM-104', 'RM-105', 'RM-106', 'RM-107', 'RM-108', 'RM-201', 'RM-203', 'UN-1'];
    const names = ['Aarav Sharma', 'Pooja Verma', 'Vikram Singh', 'Ananya Patel', 'Rohan Gupta', 'Neha Deshmukh', 'Karan Mehra', 'Sneha Reddy'];

    const batchSize = 1000;
    let inserted = 0;

    for (let i = 0; i < count; i += batchSize) {
      const currentBatch = Math.min(batchSize, count - i);
      const docs = [];
      for (let j = 0; j < currentBatch; j++) {
        const num = i + j + 1;
        const prop = propertyOptions[num % propertyOptions.length];
        const rm = prop === 'azuresuite' ? 'UN-1' : rooms[num % (rooms.length - 1)];
        const dayOffset = (num % 300) - 150;
        const checkInDate = new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10);
        const checkOutDate = new Date(Date.now() + (dayOffset + 2) * 86400000).toISOString().slice(0, 10);
        const guestName = names[num % names.length] + ' ' + num;

        docs.push({
          id: `BK-TEST-${String(num).padStart(6, '0')}`,
          property: prop,
          roomId: rm,
          guestId: `GU-TEST-${num % 500}`,
          guestName,
          mobile: `98${String(10000000 + num).slice(-8)}`,
          email: `guest${num}@example.com`,
          adults: 2,
          children: 0,
          checkIn: checkInDate,
          checkOut: checkOutDate,
          rate: 3000 + (num % 2000),
          discount: 0,
          advance: 1000,
          source: sources[num % sources.length],
          status: statuses[num % statuses.length],
          payment: 'partial',
          notes: 'Automated test booking record for pagination benchmark',
          createdBy: 'Test Suite',
          createdDate: checkInDate
        });
      }
      await Booking.insertMany(docs, { ordered: false });
      inserted += currentBatch;
    }

    const totalBookings = await Booking.countDocuments();

    res.json({
      success: true,
      message: `Successfully seeded ${inserted} test booking records into MongoDB!`,
      totalBookings
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. POST /api/bookings/clean-test-data — Clean up synthetic benchmark records
router.post('/clean-test-data', optionalAuth, async (req, res) => {
  try {
    const deleted = await Booking.deleteMany({ id: /^BK-(TEST|SYNC-TEST)-/ });
    const remaining = await Booking.countDocuments();
    broadcast('availability_updated');
    res.json({
      success: true,
      message: `Cleaned up ${deleted.deletedCount} synthetic test booking(s).`,
      remaining
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

