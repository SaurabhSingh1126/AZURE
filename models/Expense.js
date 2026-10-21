const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
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
  category: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  date: {
    type: String,
    required: true,
    index: true
  },
  description: {
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

module.exports = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
