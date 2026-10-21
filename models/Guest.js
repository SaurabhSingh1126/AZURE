const mongoose = require('mongoose');

const guestSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
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
  address: {
    type: String,
    default: ''
  },
  idType: {
    type: String,
    default: ''
  },
  idNumber: {
    type: String,
    default: ''
  },
  properties: [{
    type: String
  }],
  totalStays: {
    type: Number,
    default: 1
  },
  totalSpend: {
    type: Number,
    default: 0
  },
  outstanding: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

guestSchema.index({ name: 'text', mobile: 'text', email: 'text' });

module.exports = mongoose.models.Guest || mongoose.model('Guest', guestSchema);
