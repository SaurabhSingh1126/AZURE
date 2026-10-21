const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  property: {
    type: String,
    required: true,
    enum: ['azurevista', 'azuresuite', 'Azure Vista', 'Azure Suite'],
    index: true
  },
  roomId: {
    type: String,
    required: true,
    index: true
  },
  guestId: {
    type: String,
    index: true
  },
  guestName: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  mobile: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  email: {
    type: String,
    trim: true,
    default: ''
  },
  adults: {
    type: Number,
    default: 1,
    min: 1
  },
  children: {
    type: Number,
    default: 0,
    min: 0
  },
  checkIn: {
    type: String,
    required: true,
    index: true
  },
  checkInTime: {
    type: String,
    default: '13:00'
  },
  checkOut: {
    type: String,
    required: true,
    index: true
  },
  checkOutTime: {
    type: String,
    default: '11:00'
  },
  rate: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
  advance: {
    type: Number,
    default: 0,
    min: 0
  },
  source: {
    type: String,
    required: true,
    default: 'OFFLINE',
    index: true
  },
  status: {
    type: String,
    required: true,
    default: 'reserved',
    index: true
  },
  payment: {
    type: String,
    enum: ['unpaid', 'partial', 'paid'],
    default: 'unpaid',
    index: true
  },
  balance: {
    type: Number,
    default: null
  },
  otaSyncStatus: {
    type: String,
    default: 'SYNCED'
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    default: 'Front Desk'
  },
  createdDate: {
    type: String,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for fast multi-tenant & availability queries
bookingSchema.index({ property: 1, checkIn: 1, checkOut: 1 });
bookingSchema.index({ roomId: 1, checkIn: 1, checkOut: 1, status: 1 });
bookingSchema.index({ guestName: 'text', mobile: 'text', id: 'text' });

module.exports = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
