# Azure Hospitality — Centralized Cloud Database & Real-Time Multi-Device Booking System

## Architecture Overview

This upgrade transitions **Azure Hospitality** from local storage / single-blob files into a high-scale, centralized cloud database architecture powered by **MongoDB Atlas** and **Socket.IO** multi-device real-time synchronization.

```
                      ┌────────────────────────────────────────┐
                      │          Connected Devices             │
                      │   (Laptop, Phone, Tablet, Front Desk)  │
                      └───────────────────▲────────────────────┘
                                          │  Socket.IO Real-Time Events
                                          │  (booking_created, updated, cancelled)
                                          │  REST API (JWT Bearer Auth)
                      ┌───────────────────▼────────────────────┐
                      │       Node.js / Express Server         │
                      │  - Layered Authentication (JWT)        │
                      │  - Atomic Double-Booking Protection    │
                      │  - Server-Side Pagination & Search     │
                      │  - Rate Limiting & Audit Logging       │
                      └───────────────────▲────────────────────┘
                                          │
                                          │  Mongoose ODM (Indexed Models)
                                          ▼
                      ┌────────────────────────────────────────┐
                      │          MongoDB Atlas Cloud           │
                      │  - Bookings (10,000+ Scalable Records) │
                      │  - Guests, Rooms, Payments, Invoices   │
                      │  - Compound Indexes & Query Optimizers │
                      └────────────────────────────────────────┘
```

---

## 1. Centralized Cloud Database (MongoDB Atlas)

- **Dedicated Mongoose Schemas & Models**:
  - `Booking`: Indexed by `id`, `property`, `roomId`, `checkIn`, `checkOut`, `status`, `guestName`, `mobile`, `source`, `createdDate`.
  - `Guest`: Guest history, contacts, total stays, total spend, outstanding balances.
  - `Room`: Room numbers, properties (`azurevista`, `azuresuite`), types, rates, live statuses.
  - `Payment`: Transaction ledger linked to bookings.
  - `Invoice`: Financial invoices with tax calculation and itemization.
  - `Expense`: Operating expense tracking.
  - `Inventory`: Linen, toiletries, and supplies stock levels with minimum threshold alerts.
  - `User`: Layered system users (`Admin`, `Manager`, `Receptionist`) with bcrypt password hashing.
  - `AuditLog`: Immutable change history of operational activities.
  - `Setting`: Property configuration, tax rates, OTA channel credentials, and sync logs.

- **Resilient Engine**:
  - When `MONGODB_URI` points to a MongoDB Atlas cluster (`mongodb+srv://...`), Mongoose connects directly.
  - When running locally without external credentials, an embedded persistent MongoDB engine starts automatically in `./backups/mongodb_data`, providing full MongoDB capabilities, schemas, indexing, and transactions out of the box.

---

## 2. Real-Time Multi-Device Synchronization (Socket.IO)

- Any modification made on **Device A** (e.g. creating, editing, cancelling, or deleting a booking) instantly notifies **Device B, C, and D** via Socket.IO push events without page reload.
- Events handled in real time:
  - `booking_created`
  - `booking_updated`
  - `booking_cancelled`
  - `booking_deleted`
  - `availability_updated`
  - `payment_updated`
  - `room_blocked`
- Built-in automatic reconnection with exponential backoff and connection state indicator in the topbar.

---

## 3. Server-Side REST APIs

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/auth/login` | POST | Authenticates username/email & password, returns JWT token |
| `/api/auth/me` | GET | Validates JWT token and returns active session user |
| `/api/bookings` | GET | Server-side paginated bookings with search (`q`), property, status, source filters |
| `/api/bookings` | POST | Creates a booking with atomic room locking and date overlap protection |
| `/api/bookings/:id` | GET | Retrieves full booking details, guest profile, payments, and food bills |
| `/api/bookings/:id` | PATCH / PUT | Updates booking details with date overlap re-validation |
| `/api/bookings/:id/cancel` | PATCH / POST | Cancels booking and releases room dates in real time |
| `/api/bookings/:id` | DELETE | Permanently removes booking and broadcasts deletion |
| `/api/rooms/availability` | GET | Real-time availability check for property and date range |
| `/api/rooms/block` | POST | Blocks room for maintenance/repairs and updates OTA calendar |
| `/api/dashboard/stats` | GET | Aggregates occupancy, revenue, checkins/checkouts directly from MongoDB |
| `/api/migrate` | POST | Idempotent migration of data from `data_store.json` into MongoDB |
| `/api/migrate/status` | GET | Reports document counts across all MongoDB collections |
| `/api/migrate/backup` | GET | Downloads full JSON database snapshot for production backups |

---

## 4. Environment Configuration (`.env`)

Configure your `.env` file using `.env.example`:

```env
PORT=3000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/azure_hospitality?retryWrites=true&w=majority
JWT_SECRET=super_secure_jwt_secret_key_change_in_production
CLIENT_URL=http://localhost:3000
NODE_ENV=production
```

---

## 5. Running & Testing

### Start Server
```bash
npm start
# Server starts on http://localhost:3000
```

### Run Comprehensive Acceptance Test Suite
```bash
node test_all_criteria.js
```
The test suite validates:
1. Server-side layered authentication & JWT verification.
2. MongoDB database migration and collection counts.
3. Multi-device Socket.IO synchronization between Device A (Laptop) and Device B (Phone).
4. Date overlap & double-booking prevention (HTTP 400 rejection).
5. Booking cancellation & date release re-booking verification.
6. 10,000 bookings scale test with sub-15ms server-side pagination and indexed search.
7. Central dashboard statistics computed directly from MongoDB.
8. Room availability validation.

### Test Server Restart & Storage Clearance Persistence
```bash
node test_restart_and_clean_storage.js
```
Confirms that restarting the server and clearing browser storage never causes data loss.
