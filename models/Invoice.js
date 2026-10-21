const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  bookingId: {
    type: String,
    required: true,
    index: true
  },
  property: {
    type: String,
    required: true,
    index: true
  },
  guestName: {
    type: String,
    required: true
  },
  date: {
    type: String,
    required: true
  },
  subtotal: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  tax: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    default: 0
  },
  advance: {
    type: Number,
    default: 0
  },
  balance: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
