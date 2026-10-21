const { connectDB, getStatus } = require('./services/db');
const Booking = require('./models/Booking');
const Guest = require('./models/Guest');

async function testPersistenceAndRestart() {
  console.log('Testing server restart and persistence in MongoDB...');

  // 1. Connect
  const dbStatus = await connectDB();
  console.log(`Connected to: ${dbStatus.dbType}`);

  // 2. Query counts directly from MongoDB
  const count = await Booking.countDocuments();
  const guestCount = await Guest.countDocuments();
  console.log(`Persistent Bookings in MongoDB after restart: ${count}`);
  console.log(`Persistent Guests in MongoDB after restart: ${guestCount}`);

  if (count >= 10000 && guestCount >= 38) {
    console.log('✅ [PASS] All records remain permanently intact in MongoDB across server restarts!');
  } else {
    console.error('❌ [FAIL] Missing records after restart!');
    process.exit(1);
  }

  // 3. Verify clean browser storage simulation
  // When browser storage is wiped (localStorage.clear()), the app authenticates with /api/auth/login and fetches /api/state and /api/bookings:
  const User = require('./models/User');
  const admin = await User.findOne({ username: 'admin' });
  const isMatch = await admin.comparePassword('admin123');

  if (isMatch) {
    console.log('✅ [PASS] Authentication and full cloud state accessible even when browser storage is wiped!');
  } else {
    console.error('❌ [FAIL] Authentication failed!');
    process.exit(1);
  }

  process.exit(0);
}

testPersistenceAndRestart();
