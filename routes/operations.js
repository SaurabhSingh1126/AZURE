const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');
const Expense = require('../models/Expense');
const Inventory = require('../models/Inventory');
const Invoice = require('../models/Invoice');
const Guest = require('../models/Guest');
const Booking = require('../models/Booking');
const AuditLog = require('../models/AuditLog');
const Setting = require('../models/Setting');
const { broadcast } = require('../services/realtime');
const { optionalAuth } = require('../middleware/auth');

// POST /api/payments — Record payment
router.post('/payments', optionalAuth, async (req, res) => {
  try {
    const { bookingId, property, amount, method, date, notes, addedBy } = req.body;
    if (!bookingId || !amount) {
      return res.status(400).json({ success: false, message: 'Booking ID and amount are required.' });
    }

    const paymentId = 'TXN-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const payment = await Payment.create({
      id: paymentId,
      bookingId,
      property: property || 'azurevista',
      amount: Number(amount),
      method: method || 'Cash',
      date: date || new Date().toISOString().slice(0, 10),
      notes: notes || '',
      addedBy: addedBy || req.user?.name || 'Front Desk'
    });

    // Update booking advance / payment status
    const booking = await Booking.findOne({ id: bookingId });
    if (booking) {
      booking.advance = (booking.advance || 0) + Number(amount);
      const d1 = new Date(booking.checkIn + 'T00:00:00');
      const d2 = new Date(booking.checkOut + 'T00:00:00');
      const nights = Math.max(1, Math.round((d2 - d1) / 86400000));
      const gross = (booking.rate * nights) - (booking.discount || 0);
      booking.payment = booking.advance >= gross ? 'paid' : (booking.advance > 0 ? 'partial' : 'unpaid');
      await booking.save();
      broadcast('booking_updated', { booking });
    }

    // Audit log
    await AuditLog.create({
      id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      user: addedBy || req.user?.name || 'Front Desk',
      action: 'Payment Recorded',
      property: property || 'azurevista',
      record: payment.id,
      date: new Date().toISOString()
    });

    broadcast('payment_updated', { payment });

    res.status(201).json({ success: true, message: 'Payment recorded successfully.', payment });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/expenses — Record expense
router.post('/expenses', optionalAuth, async (req, res) => {
  try {
    const { property, category, amount, date, description, addedBy } = req.body;
    if (!category || !amount) {
      return res.status(400).json({ success: false, message: 'Category and amount are required.' });
    }

    const expId = 'EXP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const expense = await Expense.create({
      id: expId,
      property: property || 'azurevista',
      category,
      amount: Number(amount),
      date: date || new Date().toISOString().slice(0, 10),
      description: description || '',
      addedBy: addedBy || req.user?.name || 'Front Desk'
    });

    broadcast('expense_updated', { expense });

    res.status(201).json({ success: true, message: 'Expense recorded successfully.', expense });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/inventory — Update inventory item
router.post('/inventory', optionalAuth, async (req, res) => {
  try {
    const { id, property, item, category, unit, minStock, stock, purchasePrice, supplier } = req.body;
    const invId = id || ('INV-' + Math.random().toString(36).slice(2, 8).toUpperCase());

    const doc = await Inventory.findOneAndUpdate(
      { id: invId },
      {
        $set: {
          property: property || 'azurevista',
          item,
          category: category || 'General',
          unit: unit || 'pcs',
          minStock: Number(minStock || 10),
          stock: Number(stock || 0),
          purchasePrice: Number(purchasePrice || 0),
          supplier: supplier || ''
        }
      },
      { upsert: true, new: true }
    );

    broadcast('inventory_updated', { item: doc });

    res.json({ success: true, message: 'Inventory updated successfully.', item: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/invoices — Save invoice
router.post('/invoices', optionalAuth, async (req, res) => {
  try {
    const invData = req.body;
    if (!invData.id || !invData.bookingId) {
      return res.status(400).json({ success: false, message: 'Invoice ID and Booking ID required.' });
    }

    const inv = await Invoice.findOneAndUpdate(
      { id: invData.id },
      { $set: invData },
      { upsert: true, new: true }
    );

    broadcast('invoice_created', { invoice: inv });

    res.json({ success: true, message: 'Invoice saved.', invoice: inv });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/settings — Update system settings, business profile, taxes, properties, and rooms
router.post('/settings', optionalAuth, async (req, res) => {
  try {
    const { settings, properties, rooms, units, invoiceSeq } = req.body;
    const mongoose = require('mongoose');
    const { updateStore } = require('../services/storeSync');

    // 1. Update data_store.json immediately
    updateStore(store => {
      if (settings) store.settings = { ...(store.settings || {}), ...settings };
      if (properties) store.properties = { ...(store.properties || {}), ...properties };
      if (Array.isArray(rooms)) store.rooms = rooms;
      if (Array.isArray(units)) store.units = units;
      if (invoiceSeq !== undefined) store.invoiceSeq = Number(invoiceSeq);
    });

    // 2. If MongoDB is connected, update Setting and Room collections
    if (mongoose.connection.readyState === 1) {
      const updateFields = {};
      if (settings) updateFields.settings = settings;
      if (properties) updateFields.properties = properties;
      if (invoiceSeq !== undefined) updateFields.invoiceSeq = Number(invoiceSeq);

      await Setting.findOneAndUpdate(
        { key: 'system_settings' },
        { $set: updateFields },
        { upsert: true, new: true }
      );

      // Update room rates, numbers, and types in Room collection
      if (Array.isArray(rooms)) {
        for (const r of rooms) {
          if (r.id) {
            await Room.findOneAndUpdate(
              { id: r.id },
              {
                $set: {
                  number: r.number,
                  type: r.type,
                  rate: Number(r.rate || 0),
                  isUnit: false,
                  property: r.property || 'azurevista'
                }
              },
              { upsert: true }
            );
          }
        }
        const roomIds = rooms.map(r => r.id).filter(Boolean);
        if (roomIds.length > 0) {
          await Room.deleteMany({ isUnit: false, id: { $nin: roomIds } });
        }
      }

      if (Array.isArray(units)) {
        for (const u of units) {
          if (u.id) {
            await Room.findOneAndUpdate(
              { id: u.id },
              {
                $set: {
                  number: u.number,
                  type: u.type,
                  rate: Number(u.rate || 0),
                  isUnit: true,
                  property: u.property || 'azuresuite'
                }
              },
              { upsert: true }
            );
          }
        }
        const unitIds = units.map(u => u.id).filter(Boolean);
        if (unitIds.length > 0) {
          await Room.deleteMany({ isUnit: true, id: { $nin: unitIds } });
        }
      }

      // Record audit log
      await AuditLog.create({
        id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        user: req.user?.name || 'Admin',
        action: 'System Settings Updated',
        property: 'all',
        record: 'Settings',
        date: new Date().toISOString()
      }).catch(() => {});
    }

    broadcast('settings_updated', { settings, properties, rooms, units });

    res.json({
      success: true,
      message: 'Settings updated successfully and synchronized to database.',
      settings,
      properties
    });
  } catch (err) {
    console.error('[Settings Update Error]:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
