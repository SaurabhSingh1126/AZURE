/**
 * Comprehensive Acceptance Test Suite for Azure Hospitality
 * Verifies all 8 testing & acceptance criteria required by the prompt
 */

const http = require('http');
const { io: ClientIO } = require('socket.io-client');
const app = require('./server');

let targetPort = 3000;
let serverInstance = null;
let authToken = '';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const url = `http://localhost:${targetPort}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: res.status, ok: res.ok, data: json };
}

async function runTests() {
  console.log('================================================================');
  console.log('🚀 STARTING AZURE HOSPITALITY CENTRAL CLOUD DB & SYNC TEST SUITE');
  console.log('================================================================\n');

  try {
    const ping = await fetch('http://localhost:3000/api/auth/me');
    targetPort = 3000;
    console.log(`[Test Server] Connected to running server on http://localhost:3000\n`);
  } catch (e) {
    targetPort = 3099;
    serverInstance = http.createServer(app);
    const { initRealtime } = require('./services/realtime');
    initRealtime(serverInstance);
    await new Promise(res => serverInstance.listen(targetPort, res));
    console.log(`[Test Server] Listening on http://localhost:${targetPort}\n`);
  }

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Authentication & JWT Generation
    // -------------------------------------------------------------
    console.log('--- TEST 1: Server-Side Layered Authentication ---');
    const loginRes = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123', role: 'Admin' }
    });
    assert(loginRes.ok && loginRes.data.token, 'Admin login succeeds and returns signed JWT token');
    authToken = loginRes.data.token;

    const meRes = await request('/api/auth/me');
    assert(meRes.ok && meRes.data.user && meRes.data.user.role === 'Admin', 'Verified JWT session profile (/api/auth/me)');

    // -------------------------------------------------------------
    // TEST 2: Data Migration Verification
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Cloud Database State & Migration Status ---');
    const migStatus = await request('/api/migrate/status');
    assert(migStatus.ok && migStatus.data.collectionCounts.bookings >= 6, `Migrated bookings in MongoDB: ${migStatus.data.collectionCounts.bookings} records`);
    assert(migStatus.ok && migStatus.data.collectionCounts.guests >= 38, `Migrated guests in MongoDB: ${migStatus.data.collectionCounts.guests} records`);
    assert(migStatus.ok && migStatus.data.collectionCounts.rooms >= 11, `Migrated rooms & units in MongoDB: ${migStatus.data.collectionCounts.rooms} records`);

    // -------------------------------------------------------------
    // TEST 3: Multi-Device Real-Time Sync (Device A & Device B)
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Multi-Device Synchronization via Socket.IO ---');
    const deviceAEvents = [];
    const deviceBEvents = [];

    const socketA = ClientIO(`http://localhost:${targetPort}`, { query: { deviceId: 'Device-A-Laptop' } });
    const socketB = ClientIO(`http://localhost:${targetPort}`, { query: { deviceId: 'Device-B-Phone' } });

    await new Promise(resolve => {
      let count = 0;
      socketA.on('connect', () => { count++; if (count === 2) resolve(); });
      socketB.on('connect', () => { count++; if (count === 2) resolve(); });
    });

    socketA.on('booking_created', msg => deviceAEvents.push({ type: 'created', booking: msg.data?.booking || msg.booking }));
    socketA.on('booking_updated', msg => deviceAEvents.push({ type: 'updated', booking: msg.data?.booking || msg.booking }));
    socketB.on('booking_created', msg => deviceBEvents.push({ type: 'created', booking: msg.data?.booking || msg.booking }));
    socketB.on('booking_updated', msg => deviceBEvents.push({ type: 'updated', booking: msg.data?.booking || msg.booking }));

    console.log('[Multi-Device] Device A (Laptop) and Device B (Phone) connected to cloud Socket.IO hub.');

    // Device A creates a booking
    const testBookingId = 'BK-SYNC-TEST-' + Math.floor(Math.random() * 90000 + 10000);
    const createRes = await request('/api/bookings', {
      method: 'POST',
      body: {
        customId: testBookingId,
        property: 'azurevista',
        roomId: 'RM-105',
        guestName: 'Multi-Device Test Guest',
        mobile: '9812349999',
        email: 'multidevice@example.com',
        checkIn: '2029-05-10',
        checkOut: '2029-05-14',
        rate: 3200,
        advance: 3200,
        source: 'Direct'
      }
    });

    assert(createRes.ok && createRes.data.booking && createRes.data.booking.id === testBookingId, `Device A created booking ${testBookingId}`);

    // Wait for Socket.IO event propagation
    await sleep(500);
    const deviceBReceived = deviceBEvents.find(e => e.type === 'created' && e.booking?.id === testBookingId);
    assert(!!deviceBReceived, 'Device B instantly received booking_created event from cloud database');

    // Device B edits the booking
    const editRes = await request(`/api/bookings/${testBookingId}`, {
      method: 'PATCH',
      body: {
        guestName: 'Multi-Device Guest Updated By Device B',
        rate: 3500
      }
    });

    assert(editRes.ok && editRes.data.booking && editRes.data.booking.guestName.includes('Updated By Device B'), 'Device B successfully edited the booking');

    await sleep(500);
    const deviceAReceivedUpdate = deviceAEvents.find(e => e.type === 'updated' && e.booking?.id === testBookingId);
    assert(!!deviceAReceivedUpdate, 'Device A instantly received booking_updated event reflecting Device B edits');

    // -------------------------------------------------------------
    // TEST 4: Duplicate Booking & Overlapping Dates Prevention
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Overlapping Dates & Double Booking Prevention ---');
    // Try to book RM-105 with overlapping dates: 2029-05-12 to 2029-05-16 (existing is 2029-05-10 to 2029-05-14)
    const duplicateRes = await request('/api/bookings', {
      method: 'POST',
      body: {
        property: 'azurevista',
        roomId: 'RM-105',
        guestName: 'Double Booking Attempter',
        mobile: '9999900000',
        checkIn: '2029-05-12',
        checkOut: '2029-05-16',
        rate: 3200
      }
    });

    assert(duplicateRes.status === 400 && duplicateRes.data.message.includes('already booked'), 'Backend correctly rejects overlapping booking attempt (HTTP 400 with explanation)');

    // -------------------------------------------------------------
    // TEST 5: Cancellation & Room Release
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Booking Cancellation & Dates Release ---');
    const cancelRes = await request(`/api/bookings/${testBookingId}/cancel`, {
      method: 'PATCH'
    });
    assert(cancelRes.ok && cancelRes.data.booking && cancelRes.data.booking.status === 'cancelled', 'Booking cancelled successfully');

    // Now re-booking RM-105 for 2029-05-10 to 2029-05-14 should succeed because dates were released!
    const rebookRes = await request('/api/bookings', {
      method: 'POST',
      body: {
        property: 'azurevista',
        roomId: 'RM-105',
        guestName: 'New Guest After Cancellation',
        mobile: '9888877777',
        checkIn: '2029-05-10',
        checkOut: '2029-05-14',
        rate: 3200
      }
    });
    assert(rebookRes.ok, 'Re-booking released dates succeeds after cancellation');

    // Clean up re-booking
    if (rebookRes.data.booking) {
      await request(`/api/bookings/${rebookRes.data.booking.id}`, { method: 'DELETE' });
    }
    await request(`/api/bookings/${testBookingId}`, { method: 'DELETE' });

    // -------------------------------------------------------------
    // TEST 6: Scale Test — 10,000 Bookings with Server-Side Pagination
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: High Volume Scale Test (10,000 Bookings Pagination Benchmark) ---');
    console.log('Seeding test bookings into MongoDB...');
    const seedRes = await request('/api/bookings/seed-test-data', {
      method: 'POST',
      body: { count: 10000 }
    });
    assert(seedRes.ok, `Seeded test data: Total bookings in MongoDB = ${seedRes.data.totalBookings}`);

    // Retrieve Page 1
    const t0 = Date.now();
    const page1Res = await request('/api/bookings?page=1&limit=25');
    const latencyP1 = Date.now() - t0;
    assert(page1Res.ok && page1Res.data.bookings.length === 25, `Retrieved Page 1 (25 records) in ${latencyP1}ms`);
    assert(page1Res.data.pagination.total >= 10000, `Pagination metadata reports total >= 10,000 (Actual: ${page1Res.data.pagination.total})`);

    // Retrieve Page 100
    const t1 = Date.now();
    const page100Res = await request('/api/bookings?page=100&limit=50');
    const latencyP100 = Date.now() - t1;
    assert(page100Res.ok && page100Res.data.bookings.length === 50, `Retrieved Page 100 (50 records) in ${latencyP100}ms`);

    // Test Search over 10,000 records
    const t2 = Date.now();
    const searchRes = await request('/api/bookings?q=BK-TEST-000500');
    const latencySearch = Date.now() - t2;
    assert(searchRes.ok && searchRes.data.bookings.length >= 1, `Fast indexed search found record in ${latencySearch}ms`);

    // -------------------------------------------------------------
    // TEST 7: Dashboard Aggregated Statistics from Database
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Central Dashboard Statistics Aggregation ---');
    const statsRes = await request('/api/dashboard/stats');
    assert(statsRes.ok && statsRes.data.kpis.totalBookings >= 15, `Dashboard KPI reflects database data (Total Bookings: ${statsRes.data.kpis.totalBookings})`);
    assert(statsRes.ok && statsRes.data.roomStatus.total >= 11, `Room status breakdown calculated from database`);

    // -------------------------------------------------------------
    // TEST 8: Availability API Check
    // -------------------------------------------------------------
    console.log('\n--- TEST 8: Room Availability Verification ---');
    const availRes = await request('/api/rooms/availability?property=azurevista&checkIn=2026-10-15&checkOut=2026-10-18');
    assert(availRes.ok && availRes.data.totalRooms >= 10, `Availability query returned ${availRes.data?.totalRooms} rooms with availability status`);

    // Clean up test data
    console.log('\n--- Cleaning up synthetic test data ---');
    await request('/api/bookings/clean-test-data', { method: 'POST' });

    // Close sockets
    socketA.disconnect();
    socketB.disconnect();

  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
  }

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
