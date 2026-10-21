const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Room = require('../models/Room');
const Booking = require('../models/Booking');
const Setting = require('../models/Setting');
const { broadcast } = require('../services/realtime');
const { optionalAuth } = require('../middleware/auth');

// GET /api/rooms — List rooms and units
router.get('/', async (req, res) => {
  try {
    const { property } = req.query;

    if (mongoose.connection.readyState !== 1) {
      const { getStore } = require('../services/storeSync');
      const store = getStore();
      let rooms = store.rooms || [];
      if (property && property !== 'all') rooms = rooms.filter(r => r.property === property);
      return res.json({ success: true, rooms });
    }

    const filter = {};
    if (property && property !== 'all') {
      filter.property = property;
    }
    const rooms = await Room.find(filter).sort({ number: 1 }).lean();
    res.json({ success: true, rooms });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/rooms/availability — Check room availability for specific dates
router.get('/availability', async (req, res) => {
  try {
    const property = req.query.property || 'azurevista';
    const checkIn = req.query.checkIn;
    const checkOut = req.query.checkOut;

    const filter = {};
    if (property !== 'all') {
      filter.property = property;
    }

    const allRooms = await Room.find(filter).lean();

    if (!checkIn || !checkOut) {
      return res.json({
        success: true,
        property,
        totalRooms: allRooms.length,
        rooms: allRooms
      });
    }

    // Find all active bookings overlapping the range
    const overlappingBookings = await Booking.find({
      ...(property !== 'all' ? { property } : {}),
      status: { $nin: ['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED'] },
      checkIn: { $lt: checkOut },
      checkOut: { $gt: checkIn }
    }).lean();

    const bookedRoomIds = new Set(overlappingBookings.map(b => b.roomId));

    // Find maintenance blocks
    const settingsDoc = await Setting.findOne({ key: 'system_settings' }).lean();
    const maintenanceBlocks = (settingsDoc?.maintenance || []).filter(m => {
      if (m.status === 'completed' || m.status === 'resolved') return false;
      const mStart = m.startDate || m.date || '2000-01-01';
      const mEnd = m.endDate || mStart;
      return (mStart < checkOut && mEnd > checkIn);
    });
    const maintenanceRoomIds = new Set(maintenanceBlocks.map(m => m.roomId));

    const enrichedRooms = allRooms.map(room => {
      let computedStatus = room.status;
      let activeBooking = null;

      if (maintenanceRoomIds.has(room.id)) {
        computedStatus = 'maintenance';
      } else if (bookedRoomIds.has(room.id)) {
        computedStatus = 'occupied';
        activeBooking = overlappingBookings.find(b => b.roomId === room.id);
      }

      return {
        ...room,
        computedStatus,
        isAvailableForDates: !bookedRoomIds.has(room.id) && !maintenanceRoomIds.has(room.id),
        activeBooking: activeBooking ? { id: activeBooking.id, guestName: activeBooking.guestName, checkIn: activeBooking.checkIn, checkOut: activeBooking.checkOut } : null
      };
    });

    const availableCount = enrichedRooms.filter(r => r.isAvailableForDates).length;

    res.json({
      success: true,
      property,
      checkIn,
      checkOut,
      totalRooms: allRooms.length,
      availableCount,
      occupiedCount: allRooms.length - availableCount,
      rooms: enrichedRooms
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/rooms/block — Block room for maintenance / repairs
router.post('/block', optionalAuth, async (req, res) => {
  try {
    const { property, roomId, blockType, startDate, endDate, reason, createdBy } = req.body;

    if (!property || !roomId || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Property, room, start date, and end date are required.' });
    }

    // Check if there are active bookings during this block
    const conflictBooking = await Booking.findOne({
      roomId,
      status: { $nin: ['cancelled', 'checked-out', 'no-show', 'CANCELLED', 'REJECTED'] },
      checkIn: { $lt: endDate },
      checkOut: { $gt: startDate }
    }).lean();

    if (conflictBooking) {
      return res.status(400).json({
        success: false,
        message: `Cannot block Room ${roomId}: Overlaps with booking ${conflictBooking.id} (${conflictBooking.guestName}) from ${conflictBooking.checkIn} to ${conflictBooking.checkOut}.`
      });
    }

    const maintenanceItem = {
      id: 'MN-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      property,
      roomId,
      blockType: blockType || 'maintenance',
      startDate,
      endDate,
      reason: reason || 'Scheduled maintenance',
      status: 'pending',
      createdBy: createdBy || req.user?.name || 'Front Desk',
      createdAt: new Date().toISOString()
    };

    await Setting.findOneAndUpdate(
      { key: 'system_settings' },
      { $push: { maintenance: maintenanceItem } },
      { upsert: true }
    );

    // Update room status
    await Room.findOneAndUpdate(
      { id: roomId },
      { status: 'maintenance' }
    );

    broadcast('room_blocked', { property, roomId, maintenance: maintenanceItem });
    broadcast('availability_updated', { property, roomId });

    res.json({
      success: true,
      message: `Room ${roomId} successfully blocked for ${blockType || 'maintenance'}.`,
      maintenance: maintenanceItem
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/rooms/:id/status — Update room status
router.patch('/:id/status', optionalAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required.' });
    }

    const room = await Room.findOneAndUpdate(
      { id: req.params.id },
      { $set: { status } },
      { new: true }
    );

    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    broadcast('availability_updated', { property: room.property, roomId: room.id, status });

    res.json({ success: true, message: `Room ${room.id} status updated to ${status}.`, room });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
