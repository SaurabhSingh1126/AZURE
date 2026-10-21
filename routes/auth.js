const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { generateToken, authenticate, authLimiter, requireRole } = require('../middleware/auth');

// POST /api/auth/login — Server-side secure layered authentication
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    const identifier = (username || email || '').trim().toLowerCase();

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Username/email and password are required.' });
    }

    // Offline / serverless fallback when Mongoose is disconnected
    if (mongoose.connection.readyState !== 1) {
      if ((identifier === 'admin' && password === 'admin123') ||
          (identifier === 'manager' && password === 'manager123') ||
          (identifier === 'reception' && password === 'reception123')) {
        const userRole = identifier === 'admin' ? 'Admin' : identifier === 'manager' ? 'Manager' : 'Receptionist';
        if (role && role !== userRole) {
          return res.status(401).json({ success: false, message: `User does not belong to the selected ${role} layer.` });
        }
        const user = {
          _id: 'local-' + identifier,
          name: identifier === 'admin' ? 'You (Owner / Admin)' : identifier === 'manager' ? 'Neha Kapoor (Manager)' : 'Sanjay Yadav (Receptionist)',
          role: userRole,
          email: `${identifier}@azurehospitality.in`,
          username: identifier,
          icon: identifier === 'admin' ? '🛡️' : identifier === 'manager' ? '👔' : '🎧'
        };
        const token = generateToken(user);
        return res.json({ success: true, token, user });
      }
    }

    // Find user by username or email
    const user = await User.findOne({
      $or: [
        { email: identifier },
        { username: identifier }
      ]
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials or user not found.' });
    }

    // Role-specific check if layer requested
    if (role && user.role !== role) {
      return res.status(401).json({ success: false, message: `User does not belong to the selected ${role} layer.` });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Incorrect password entered.' });
    }

    const token = generateToken(user);

    // Audit log login
    await AuditLog.create({
      id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      user: user.name,
      action: `User Authenticated (${user.role} Layer)`,
      property: 'all',
      record: user.username,
      date: new Date().toISOString()
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        email: user.email,
        username: user.username,
        icon: user.icon
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me — Verify session token
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully.' });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { targetRole, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ success: false, message: 'New password must be at least 4 characters.' });
    }

    // Only Admin can change other roles' passwords
    if (targetRole && req.user.role !== 'Admin' && req.user.role !== targetRole) {
      return res.status(403).json({ success: false, message: 'Only Admin can update other role passwords.' });
    }

    const roleToUpdate = targetRole || req.user.role;
    const user = await User.findOne({ role: roleToUpdate });
    if (!user) {
      return res.status(404).json({ success: false, message: `User with role ${roleToUpdate} not found.` });
    }

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: `Password updated for ${roleToUpdate} layer.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
