const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
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
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  method: {
    type: String,
    default: 'Cash'
  },
  date: {
    type: String,
    required: true,
    index: true
  },
  notes: {
    type: String,
    default: ''
  },
  addedBy: {
    type: String,
    default: 'Front Desk'
  }
}, {
  timestamps: true
});

paymentSchema.index({ property: 1, date: 1 });

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
