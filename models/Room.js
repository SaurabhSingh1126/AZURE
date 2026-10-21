const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  property: {
    type: String,
    required: true,
    enum: ['azurevista', 'azuresuite', 'Azure Vista', 'Azure Suite'],
    index: true
  },
  number: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true
  },
  rate: {
    type: Number,
    required: true,
    default: 0
  },
  status: {
    type: String,
    required: true,
    enum: ['available', 'occupied', 'reserved', 'cleaning', 'maintenance', 'blocked'],
    default: 'available',
    index: true
  },
  isUnit: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

roomSchema.index({ property: 1, status: 1 });

module.exports = mongoose.models.Room || mongoose.model('Room', roomSchema);
