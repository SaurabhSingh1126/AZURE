const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  property: {
    type: String,
    required: true,
    index: true
  },
  item: {
    type: String,
    required: true
  },
  category: {
    type: String,
    default: 'General'
  },
  unit: {
    type: String,
    default: 'pcs'
  },
  minStock: {
    type: Number,
    default: 10
  },
  stock: {
    type: Number,
    default: 0
  },
  purchasePrice: {
    type: Number,
    default: 0
  },
  supplier: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.Inventory || mongoose.model('Inventory', inventorySchema);
