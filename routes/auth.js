const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { generateToken, authenticate, authLimiter, requireRole } = require('../middleware/auth');

const BUILTIN_USERS = [
  {
    username: 'admin',
    aliases: ['admin', 'owner', 'admin@azurehospitality.in', 'owner@azurehospitality.in'],
    pass: 'admin123',
    role: 'Admin',
    name: 'You (Owner / Admin)',
    email: 'admin@azurehospitality.in',
    icon: '🛡️'
  },
  {
    username: 'manager',
    aliases: ['manager', 'neha', 'manager@azurehospitality.in'],
    pass: 'manager123',
    role: 'Manager',
    name: 'Neha Kapoor (Manager)',
    email: 'manager@azurehospitality.in',
    icon: '👔'
  },
  {
    username: 'reception',
    aliases: ['reception', 'receptionist', 'sanjay', 'reception@azurehospitality.in'],
    pass: 'reception123',
    role: 'Receptionist',
    name: 'Sanjay Yadav (Receptionist)',
    email: 'reception@azurehospitality.in',
    icon: '🎧'
  }
];

// POST /api/auth/login — Server-side secure layered authentication
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    const identifier = (username || email || '').trim().toLowerCase();

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Username/email and password are required.' });
    }

    // 1. Instant check for primary built-in layer users (Admin, Manager, Receptionist)
    const matchedBuiltin = BUILTIN_USERS.find(u =>
      u.username === identifier || u.email === identifier || u.aliases.includes(identifier)
    );

    if (matchedBuiltin) {
      if (password !== matchedBuiltin.pass) {
        return res.status(401).json({ success: false, message: 'Incorrect password entered.' });
      }
      if (role && role !== matchedBuiltin.role) {
        return res.status(401).json({ success: false, message: `User does not belong to the selected ${role} layer.` });
      }

      const tokenUser = {
        id: 'user-' + matchedBuiltin.username,
        name: matchedBuiltin.name,
        role: matchedBuiltin.role,
        email: matchedBuiltin.email,
        username: matchedBuiltin.username,
        icon: matchedBuiltin.icon
      };

      const token = generateToken(tokenUser);

      // Best-effort audit logging
      if (mongoose.connection.readyState === 1) {
        AuditLog.create({
          id: 'AL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          user: matchedBuiltin.name,
          action: `User Authenticated (${matchedBuiltin.role} Layer)`,
          property: 'all',
          record: matchedBuiltin.username,
          date: new Date().toISOString()
        }).catch(() => {});
      }

      return res.json({ success: true, token, user: tokenUser });
    }

    // 2. Database user lookup (only if MongoDB connection is ready, preventing buffering timeout)
    if (mongoose.connection.readyState === 1) {
      const user = await User.findOne({
        $or: [
          { email: identifier },
          { username: identifier }
        ]
      });

      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials or user not found.' });
      }

      if (role && user.role !== role) {
        return res.status(401).json({ success: false, message: `User does not belong to the selected ${role} layer.` });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Incorrect password entered.' });
      }

      const token = generateToken(user);
      return res.json({
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
    }

    return res.status(401).json({ success: false, message: 'Invalid credentials or user not found.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me — Verify session token
router.get('/me', authenticate, async (req, res) => {
  try {
    if (req.user && req.user.username) {
      return res.json({
        success: true,
        user: {
          id: req.user.id,
          name: req.user.name,
          role: req.user.role,
          email: req.user.email,
          username: req.user.username
        }
      });
    }

    if (mongoose.connection.readyState === 1 && req.user && req.user.id) {
      const user = await User.findById(req.user.id).select('-password');
      if (user) {
        return res.json({ success: true, user });
      }
    }

    res.status(404).json({ success: false, message: 'User not found.' });
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
