const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  user: {
    type: String,
    required: true
  },
  action: {
    type: String,
    required: true
  },
  property: {
    type: String,
    default: 'all'
  },
  roomId: {
    type: String
  },
  record: {
    type: String,
    default: ''
  },
  date: {
    type: String,
    default: () => new Date().toISOString(),
    index: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
