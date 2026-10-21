const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'system_settings'
  },
  properties: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  suppliers: {
    type: Array,
    default: []
  },
  staff: {
    type: Array,
    default: []
  },
  maintenance: {
    type: Array,
    default: []
  },
  housekeeping: {
    type: Array,
    default: []
  },
  foodBills: {
    type: Array,
    default: []
  },
  ota: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  otaSyncLogs: {
    type: Array,
    default: []
  },
  otaConflicts: {
    type: Array,
    default: []
  },
  otaSyncQueue: {
    type: Array,
    default: []
  },
  otaRoomMappings: {
    type: Array,
    default: []
  },
  processedWebhookEvents: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  invoiceSeq: {
    type: Number,
    default: 10
  },
  lastSync: {
    type: String,
    default: () => new Date().toISOString()
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.Setting || mongoose.model('Setting', settingSchema);
